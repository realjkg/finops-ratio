// Change-management identifier grammars. Every caller-supplied ticketRef is
// checked against its provider's grammar BEFORE it is placed in any URL, so a
// ref cannot steer the authenticated server-side ITSM request (path traversal,
// query / fragment injection, ServiceNow encoded-query operators like `^OR`).
//
// Browser-safe (no credentials): the regexes are pure data.

/**
 * Jira issue key: project key (uppercase letter, then uppercase letters,
 * digits or underscore; at most 255 chars) + `-` + issue number (no leading
 * zero, at most 10 digits). ASCII only — `\d` / `\w` are deliberately avoided.
 */
export const JIRA_ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,254}-[1-9][0-9]{0,9}$/;

/**
 * ServiceNow record number, e.g. CHG0030001 / RITM0010001: an uppercase
 * prefix and a digit run. Excludes every encoded-query operator (`^`, `=`,
 * `!`, `<`, `>`) and every URL delimiter.
 */
export const SERVICENOW_NUMBER = /^[A-Z]{1,16}[0-9]{1,32}$/;

export function isJiraIssueKey(ref: unknown): ref is string {
  return typeof ref === 'string' && JIRA_ISSUE_KEY.test(ref);
}

export function isServiceNowNumber(ref: unknown): ref is string {
  return typeof ref === 'string' && SERVICENOW_NUMBER.test(ref);
}

/**
 * Fixed, non-echoing 400 messages. The input is never quoted back: an invalid
 * ref is attacker-controlled text.
 */
export const INVALID_JIRA_REF_MESSAGE = 'ticketRef is not a valid Jira issue key';
export const INVALID_SERVICENOW_REF_MESSAGE =
  'ticketRef is not a valid ServiceNow record number';

/** Thrown by an adapter when a ref fails its grammar (defence in depth). */
export class InvalidTicketRefError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTicketRefError';
  }
}
