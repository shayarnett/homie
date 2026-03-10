import { execFile } from "child_process";

export interface SshConfig {
	host: string;
	user: string;
}

export class SshService {
	constructor(private config: SshConfig) {}

	async exec(command: string, options?: { timeout?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		return new Promise((resolve, reject) => {
			const target = `${this.config.user}@${this.config.host}`;
			const args = [
				"-o", "BatchMode=yes",
				"-o", "StrictHostKeyChecking=accept-new",
				"-o", "ConnectTimeout=10",
				target,
				command,
			];

			const child = execFile("ssh", args, {
				timeout: options?.timeout ?? 30000,
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

	async readFile(remotePath: string): Promise<string> {
		const result = await this.exec(`cat ${JSON.stringify(remotePath)}`);
		if (result.exitCode !== 0) {
			throw new Error(`Failed to read ${remotePath}: ${result.stderr}`);
		}
		return result.stdout;
	}

	async writeFile(remotePath: string, content: string): Promise<void> {
		// Use heredoc via ssh to write file content.
		// Randomized delimiter avoids conflicts if content contains the delimiter string.
		const delim = `HOMIE_EOF_${Date.now()}`;
		const result = await this.exec(`cat > ${JSON.stringify(remotePath)} << '${delim}'\n${content}\n${delim}`);
		if (result.exitCode !== 0) {
			throw new Error(`Failed to write ${remotePath}: ${result.stderr}`);
		}
	}
}
