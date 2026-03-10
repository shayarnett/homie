import { createConnection } from "net";
import type { LabState, ContainerInfo, ServiceInfo, HostInfo } from "../types.js";
import type { LxdService } from "../services/lxd.js";
import type { DockerService } from "../services/docker.js";
import type { HostConfig, ProxyRoute } from "../config.js";

export interface LabStateServices {
	lxd: LxdService;
	docker: DockerService;
	hosts: HostConfig[];
	domain: string;
	hostIp: string;
	proxyRoutes?: ProxyRoute[];
}

const CACHE_TTL_MS = 30_000;

/** Parse docker ps Ports field, e.g. "0.0.0.0:3456->3456/tcp, :::3456->3456/tcp" */
function parseDockerPorts(portsStr: string): { host: number; container: number }[] {
	if (!portsStr) return [];
	const ports: { host: number; container: number }[] = [];
	const seen = new Set<string>();
	for (const part of portsStr.split(",")) {
		const match = part.trim().match(/(\d+)->(\d+)/);
		if (match) {
			const host = parseInt(match[1], 10);
			const container = parseInt(match[2], 10);
			const key = `${host}:${container}`;
			if (!seen.has(key)) {
				seen.add(key);
				ports.push({ host, container });
			}
		}
	}
	return ports;
}

let cachedState: LabState | null = null;

export function getCachedLabState(): LabState | null {
	if (!cachedState) return null;
	if (Date.now() - cachedState.lastRefresh > CACHE_TTL_MS) return null;
	return cachedState;
}

export async function refreshLabState(services: LabStateServices): Promise<LabState> {
	const [containers, dockerContainers, hosts, serviceChecks] = await Promise.allSettled([
		services.lxd.list(),
		services.docker.ps(),
		checkHosts(services.hosts),
		checkProxyRoutes(services.proxyRoutes || [], services.domain),
	]);

	const lxdContainers: ContainerInfo[] =
		containers.status === "fulfilled"
			? containers.value.map((c) => ({
					name: c.name,
					status: c.status,
					ip: c.ipv4,
					type: "lxd" as const,
					ports: [],
				}))
			: [];

	const dockerList: ContainerInfo[] = [];
	if (dockerContainers.status === "fulfilled" && dockerContainers.value.stdout) {
		// Docker JSON output is one JSON object per line
		for (const line of dockerContainers.value.stdout.trim().split("\n")) {
			if (!line) continue;
			try {
				const c = JSON.parse(line);
				dockerList.push({
					name: c.Names || c.Name || "",
					status: c.State || c.Status || "",
					ip: "",
					type: "docker",
					ports: parseDockerPorts(c.Ports || ""),
				});
			} catch {
				// skip malformed lines
			}
		}
	}

	const hostList: HostInfo[] = hosts.status === "fulfilled" ? hosts.value : [];
	const serviceList: ServiceInfo[] = serviceChecks.status === "fulfilled" ? serviceChecks.value : [];

	cachedState = {
		containers: [...lxdContainers, ...dockerList],
		services: serviceList,
		hosts: hostList,
		lastRefresh: Date.now(),
	};

	return cachedState;
}

async function checkProxyRoutes(routes: ProxyRoute[], domain: string): Promise<ServiceInfo[]> {
	const results = await Promise.allSettled(
		routes.map(async (r) => {
			const healthy = await new Promise<boolean>((resolve) => {
				const sock = createConnection({ host: "127.0.0.1", port: r.port }, () => {
					sock.destroy();
					resolve(true);
				});
				sock.setTimeout(2000);
				sock.on("timeout", () => { sock.destroy(); resolve(false); });
				sock.on("error", () => resolve(false));
			});
			return {
				subdomain: r.subdomain,
				upstream: "127.0.0.1",
				port: r.port,
				healthy,
			};
		}),
	);
	return results
		.filter((r) => r.status === "fulfilled")
		.map((r) => (r as PromiseFulfilledResult<ServiceInfo>).value);
}

async function checkHosts(hosts: HostConfig[]): Promise<HostInfo[]> {
	const results = await Promise.allSettled(
		hosts.map(async (h) => {
			const { execFile } = await import("child_process");
			const reachable = await new Promise<boolean>((resolve) => {
				const timeoutFlag = process.platform === "darwin" ? "-t" : "-W";
				execFile("ping", ["-c", "1", timeoutFlag, "2", h.address], { timeout: 5000 }, (err) => {
					resolve(!err);
				});
			});
			return {
				name: h.name,
				address: h.address,
				reachable,
				gpu: h.gpu,
			};
		}),
	);

	return results
		.filter((r) => r.status === "fulfilled")
		.map((r) => (r as PromiseFulfilledResult<HostInfo>).value);
}

export function formatLabState(state: LabState): string {
	const lines: string[] = ["## Lab State"];

	if (state.hosts.length > 0) {
		lines.push("\n### Hosts");
		for (const h of state.hosts) {
			const gpu = h.gpu ? " [GPU]" : "";
			const status = h.reachable ? "UP" : "DOWN";
			lines.push(`- ${h.name} (${h.address}): ${status}${gpu}`);
		}
	}

	if (state.containers.length > 0) {
		lines.push("\n### Containers");
		for (const c of state.containers) {
			const ip = c.ip ? ` (${c.ip})` : "";
			lines.push(`- [${c.type}] ${c.name}: ${c.status}${ip}`);
		}
	}

	if (state.services.length > 0) {
		lines.push("\n### Services (nginx routes)");
		for (const s of state.services) {
			const health = s.healthy ? "healthy" : "unhealthy";
			lines.push(`- ${s.subdomain} -> ${s.upstream}:${s.port} (${health})`);
		}
	}

	if (state.gpuStatus) {
		lines.push(`\n### GPU\n${state.gpuStatus}`);
	}

	lines.push(`\n_Last refreshed: ${new Date(state.lastRefresh).toISOString()}_`);
	return lines.join("\n");
}
