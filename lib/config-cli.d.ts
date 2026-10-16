import { type GovernanceTarget, type Review } from './config-governance.js';
import type { Io } from './main.js';
export interface ConfigReviewArgs {
    root: string;
    candidate: string;
    target: GovernanceTarget;
    json: boolean;
}
export declare function parseConfigReviewArgs(argv: readonly string[]): ConfigReviewArgs | string;
export declare function renderConfigReview(r: Review): string;
export declare function runConfigReview(argv: readonly string[], io: Io): number;
