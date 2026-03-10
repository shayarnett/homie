import type { GiteaConfig } from "../config.js";

interface GiteaIssue {
	number: number;
	title: string;
	body: string;
	state: string;
	labels: { name: string }[];
	user: { login: string };
}

interface GiteaComment {
	id: number;
	body: string;
	user: { login: string };
}

export class GiteaService {
	constructor(private config: GiteaConfig) {}

	private async request(path: string, options?: { method?: string; body?: unknown }): Promise<any> {
		const url = `${this.config.url}/api/v1${path}`;
		const res = await fetch(url, {
			method: options?.method ?? "GET",
			headers: {
				"Authorization": `token ${this.config.token}`,
				"Content-Type": "application/json",
			},
			body: options?.body ? JSON.stringify(options.body) : undefined,
		});
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Gitea API ${res.status}: ${text}`);
		}
		return res.json();
	}

	private repoPath(): string {
		return `/repos/${this.config.org}/${this.config.repo}`;
	}

	async getIssue(number: number): Promise<GiteaIssue> {
		return this.request(`${this.repoPath()}/issues/${number}`);
	}

	async getIssueComments(number: number): Promise<GiteaComment[]> {
		return this.request(`${this.repoPath()}/issues/${number}/comments`);
	}

	async commentOnIssue(number: number, body: string): Promise<GiteaComment> {
		return this.request(`${this.repoPath()}/issues/${number}/comments`, {
			method: "POST",
			body: { body },
		});
	}

	async createPullRequest(opts: {
		title: string;
		body: string;
		head: string;
		base?: string;
	}): Promise<{ number: number; html_url: string }> {
		return this.request(`${this.repoPath()}/pulls`, {
			method: "POST",
			body: {
				title: opts.title,
				body: opts.body,
				head: opts.head,
				base: opts.base ?? "main",
			},
		});
	}

	async getPullRequest(number: number): Promise<{ number: number; title: string; body: string; html_url: string; head: { ref: string }; mergeable: boolean; diff_url: string }> {
		return this.request(`${this.repoPath()}/pulls/${number}`);
	}

	async getPullRequestDiff(number: number): Promise<string> {
		const url = `${this.config.url}/api/v1${this.repoPath()}/pulls/${number}.diff`;
		const res = await fetch(url, {
			headers: { "Authorization": `token ${this.config.token}` },
		});
		if (!res.ok) throw new Error(`Gitea API ${res.status}: ${await res.text()}`);
		return res.text();
	}

	async mergePullRequest(number: number, mergeStyle: string = "merge"): Promise<void> {
		await this.request(`${this.repoPath()}/pulls/${number}/merge`, {
			method: "POST",
			body: { Do: mergeStyle, merge_message_field: "" },
		});
	}

	async addLabel(number: number, label: string): Promise<void> {
		// Ensure label exists
		const labels: { id: number; name: string }[] = await this.request(`${this.repoPath()}/labels`);
		let labelObj = labels.find((l) => l.name === label);
		if (!labelObj) {
			labelObj = await this.request(`${this.repoPath()}/labels`, {
				method: "POST",
				body: { name: label, color: "#0075ca" },
			});
		}
		await this.request(`${this.repoPath()}/issues/${number}/labels`, {
			method: "POST",
			body: { labels: [labelObj!.id] },
		});
	}
}
