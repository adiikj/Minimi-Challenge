export type Intent = { memoryCue: boolean; changeCheck: boolean; sinceThen: boolean };

const MEMORY_CUE =
  /\b(?:(?:i|we)\s+(?:asked|said|discussed|talked|mentioned|shortlisted|compared|looked at|told you|chose|picked|decided|were (?:talking|looking))|you\s+(?:said|told|recommended|suggested|answered|mentioned|gave)|last time|previously|our (?:conversation|chat|discussion)|that (?:conversation|chat|list|shortlist)|remind me|what did (?:i|we|you)|did i (?:ask|say|mention)|your (?:answer|recommendation|list))\b/i;

const CHANGE_CHECK =
  /\b(?:chang(?:ed|es)|still (?:correct|true|valid|accurate|right|the case|current|up to date)|up to date|outdated|any (?:updates?|news)|shipped|launched|released|new (?:features?|releases?|pricing|plans?)|price (?:increase|hike|cut|drop)s?|since)\b/i;

const SINCE_THEN = /\bsince (?:then|that|we (?:talked|spoke|last talked))\b/i;

export function detectIntent(message: string): Intent {
  return {
    memoryCue: MEMORY_CUE.test(message),
    changeCheck: CHANGE_CHECK.test(message),
    sinceThen: SINCE_THEN.test(message),
  };
}
