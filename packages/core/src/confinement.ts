/**
 * How work an agent shaped is confined, as the domain sees it (L7.35, audit 2026-11-10 D6): the words its refusals say
 * where the work came from with — never which shell sent it. The rules are the same whatever the words. The application
 * maps its callers onto one (engine caller.ts `confinementOf`: the MCP server's, the Studio's); the domain names no
 * channel and never branches on one (agent-policy.ts's `AgentChannel` and `channelWords` until then).
 */
export interface Confinement {
  /** How a refusal names where the work came from ("through MCP"). */
  readonly words: string;
  /** Said after "a file an agent can write" when the words name a way an agent writes files ("through MCP"); absent: nothing. */
  readonly writesThrough?: string;
  /** The operation that lists the themes, quoted where a theme folder is refused (`template_list`); absent: no hint. */
  readonly themeList?: string;
  /** Said of a hook that needs a person's approval, after `"confirm: true" does not count`: who approves it, or that nobody can here. */
  readonly approval: string;
}

/**
 * The confinement of agent work when none is given: its refusals are worded as the MCP server's (so are a person's
 * terminal's and an unknown submitter's, engine caller.ts).
 */
export const AGENT_CONFINEMENT: Confinement = Object.freeze({
  words: 'through MCP',
  writesThrough: 'through MCP',
  themeList: 'template_list',
  approval: ' — a human approves it when asked, or runs it in a terminal',
});

/** The confinement given, else AGENT_CONFINEMENT. */
export function confinementOrDefault(c: Confinement | undefined): Confinement {
  return c ?? AGENT_CONFINEMENT;
}

/** "through MCP": the words of a confinement (AGENT_CONFINEMENT's when none is given). */
export function confinementWords(c: Confinement | undefined): string {
  return confinementOrDefault(c).words;
}
