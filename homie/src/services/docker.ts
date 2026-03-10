import { execFile } from "child_process";

export interface DockerConfig {
	host: string;
}

export class DockerService {
	private env: NodeJS.ProcessEnv;

	constructor(private config: DockerConfig) {
		this.env = { ...process.env };
		if (config.host) {
			this.env.DOCKER_HOST = config.host;
		}
	}

	private async docker(...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		return new Promise((resolve, reject) => {
			execFile("docker", args, {
				timeout: 60000,
				maxBuffer: 10 * 1024 * 1024,
				env: this.env,
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

	async ps(all?: boolean): Promise<{ stdout: string; exitCode: number }> {
		const args = ["ps", "--format", "json"];
		if (all) args.splice(1, 0, "-a");
		return this.docker(...args);
	}

	async logs(container: string, tail?: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		const args = ["logs"];
		if (tail) args.push("--tail", String(tail));
		args.push(container);
		return this.docker(...args);
	}

	async exec(container: string, command: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		return this.docker("exec", container, ...command);
	}

	async compose(composeFile: string, subcommand: string, args?: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		return this.docker("compose", "-f", composeFile, subcommand, ...(args ?? []));
	}

	async run(image: string, args?: string[], gpus?: boolean): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		const runArgs = ["run", "--rm"];
		if (gpus) runArgs.push("--gpus", "all");
		runArgs.push(image, ...(args ?? []));
		return this.docker(...runArgs);
	}

	async nvidiaSmi(): Promise<string> {
		const result = await this.docker("run", "--rm", "--gpus", "all", "nvidia/cuda:12.6.3-base-ubuntu24.04", "nvidia-smi");
		if (result.exitCode !== 0) {
			throw new Error(`nvidia-smi failed: ${result.stderr}`);
		}
		return result.stdout;
	}
}
