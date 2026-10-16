export type Direction = 'equivalent' | 'tighten' | 'relax' | 'unknown';
export type GovernanceTarget = 'project' | 'exceptions';
export type Json = null | boolean | number | string | Json[] | {
    [key: string]: Json;
};
export type PresentValue = {
    present: false;
} | {
    present: true;
    value: Json;
};
export interface FieldChange {
    path: string;
    direction: Direction;
    reason: string;
    before: PresentValue;
    after: PresentValue;
}
export interface Review {
    valid: boolean;
    target: GovernanceTarget;
    beforeSha256: string | null;
    afterSha256: string;
    needsApproval: boolean;
    changes: FieldChange[];
    problem?: string;
}
export declare const TEXT_MAX_BYTES = 32768;
export declare const REASON_MAX_BYTES = 131072;
export declare const sha256: (s: string | Uint8Array) => string;
/** Do not let UTF-8 encoding or JSON serialization silently change review evidence. */
export declare function assertText(text: string): void;
export declare function decodeRaw(bytes: Uint8Array): string;
export declare const parseBody: (text: string) => string;
export declare function invalidReview(target: GovernanceTarget, candidate: string, beforeSha: string | null, problem: string): Review;
export declare function reviewProject(candidate: string, beforeText: string | null, beforeSha: string | null): Review;
export declare function reviewExceptions(candidate: string, beforeText: string | null, beforeSha: string | null): Review;
export declare const reviewText: (target: GovernanceTarget, candidate: string, before: string | null, hash: string | null) => Review;
