export interface MergeGroup { description: string; field: string }
export interface MergeMember { tool: string; actions: string[]; passes: boolean }

export const MERGE_GROUPS: Record<string, MergeGroup> = {};

export const MERGE_MEMBERS: Record<string, MergeMember> = {};
