export interface LabState {
	containers: ContainerInfo[];
	services: ServiceInfo[];
	hosts: HostInfo[];
	gpuStatus?: string;
	lastRefresh: number;
}

export interface ContainerInfo {
	name: string;
	status: string;
	ip: string;
	type: "lxd" | "docker";
	ports: { host: number; container: number }[];
}

export interface ServiceInfo {
	subdomain: string;
	upstream: string;
	port: number;
	healthy: boolean;
}

export interface HostInfo {
	name: string;
	address: string;
	reachable: boolean;
	gpu?: boolean;
}

export type SpecialistName = "nixie" | "termie" | "doxie" | "jinxie";
