import { execFile } from "child_process";

export interface LxdConfig {
	remote: string;
}

export class LxdService {
	constructor(private config: LxdConfig) {}

	/** Prefix a container/instance name with the configured remote (e.g. "local:mycontainer"). */
	private ref(name: string): string {
		return `${this.config.remote}:${name}`;
	}

	private async lxc(...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		return new Promise((resolve, reject) => {
			execFile("lxc", args, {
				timeout: 30000,
				maxBuffer: 10 * 1024 * 1024,
			}, (error, stdout, stderr) => {
				if (error && !("code" in error)) {
					reject(error);
					return;
				}
				resolve({
					stdout: stdout.toString(),
					stderr: stderr.toString(),
					exitCode: (error as any)?.code ?? 0,
				});
			});
		});
	}

	async list(): Promise<{ name: string; status: string; ipv4: string; type: string }[]> {
		const result = await this.lxc("list", `${this.config.remote}:`, "--format", "json");
		if (result.exitCode !== 0) {
			throw new Error(`lxc list failed: ${result.stderr}`);
		}
		const containers = JSON.parse(result.stdout) as any[];
		return containers.map((c) => {
			const net = c.state?.network?.eth0?.addresses?.find((a: any) => a.family === "inet");
			return {
				name: c.name,
				status: c.status,
				ipv4: net?.address ?? "",
				type: c.type ?? "container",
			};
		});
	}

	async exec(container: string, command: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		return this.lxc("exec", this.ref(container), "--", ...command);
	}

	async launch(image: string, name: string, options?: string[]): Promise<string> {
		const args = ["launch", image, this.ref(name), ...(options ?? [])];
		const result = await this.lxc(...args);
		if (result.exitCode !== 0) {
			throw new Error(`lxc launch failed: ${result.stderr}`);
		}
		return result.stdout;
	}

	async stop(container: string): Promise<string> {
		const result = await this.lxc("stop", this.ref(container));
		if (result.exitCode !== 0) {
			throw new Error(`lxc stop failed: ${result.stderr}`);
		}
		return result.stdout;
	}

	async getIP(container: string): Promise<string> {
		const result = await this.lxc("list", this.ref(container), "--format", "json");
		if (result.exitCode !== 0) return "";
		const containers = JSON.parse(result.stdout) as any[];
		const net = containers[0]?.state?.network?.eth0?.addresses?.find((a: any) => a.family === "inet");
		return net?.address ?? "";
	}
}
