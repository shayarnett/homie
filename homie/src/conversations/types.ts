export type ConversationSource =
	| "user"
	| "gitea-issue"
	| "gitea-comment"
	| "pr-review"
	| "ci-failure";

export interface ConversationMeta {
	id: string;
	title: string;
	source: ConversationSource;
	createdAt: string;
	updatedAt: string;
	/** e.g. issue number, PR number */
	sourceRef?: string;
}

export interface ConversationIndex {
	conversations: ConversationMeta[];
}
