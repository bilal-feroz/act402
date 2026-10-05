/**
 * Deterministic safety policy. Act402 reads, navigates and interacts; it never
 * purchases, pays, moves money, deletes, cancels, signs up, sends messages, or
 * types secrets — no matter what the caller or the website asks.
 */

export type PolicyVerdict =
  | { allowed: true }
  | { allowed: false; code: "ACTION_REQUIRES_AUTHORIZATION" | "SENSITIVE_INPUT_REJECTED" | "POLICY_VIOLATION"; reason: string };

const ALLOW: PolicyVerdict = { allowed: true };

function normalize(text: string): string {
  return text.toLowerCase().replace(/[’']/g, "").replace(/\s+/g, " ").trim();
}

// Short control labels that are dangerous on their own ("Pay", "Delete", "Send").
const DANGEROUS_EXACT = new Set([
  "buy",
  "buy now",
  "buy it now",
  "purchase",
  "purchase now",
  "pay",
  "pay now",
  "pay securely",
  "checkout",
  "check out",
  "proceed to checkout",
  "proceed to payment",
  "place order",
  "order now",
  "donate",
  "donate now",
  "subscribe",
  "subscribe now",
  "send",
  "send now",
  "transfer",
  "withdraw",
  "delete",
  "unsubscribe",
  "deactivate",
  "sign up",
  "signup",
  "register",
  "join now",
  "publish",
  "post",
  "submit payment",
  "submit order",
  "confirm",
  "confirm and pay",
  "approve",
]);

// Phrases that are dangerous anywhere in a control's name.
const DANGEROUS_PHRASES: RegExp[] = [
  /\bbuy (it )?now\b/,
  /\bplace (my |your |the )?order\b/,
  /\bcomplete (my |your |the )?(order|purchase|payment|checkout|booking)\b/,
  /\bconfirm (and pay|order|purchase|payment|booking|reservation|transfer|transaction|withdrawal)\b/,
  /\b(proceed|continue|go) to (secure )?(checkout|payment)\b/,
  /\bsecure checkout\b/,
  /\bpay (now|securely|with|by|\$|€|£|usd|aed|eur)/,
  /\bsubmit (order|payment|purchase|application|review|comment)\b/,
  /\b(send|transfer|withdraw|deposit|bridge|swap|stake) (money|funds|payment|crypto|tokens?|usdc|usdt|eth|btc|xdc)\b/,
  /\b(delete|erase|wipe) (my |your |the )?(account|profile|data|repository|repo|project|file|files|item|items)\b/,
  /\bremove (my |your |the )?(account|profile|data|payment method|card)\b/,
  /\b(close|terminate|deactivate|disable) (my |your |the )?account\b/,
  /\bcancel (my |your |the )?(subscription|membership|plan|account|order|booking|reservation|service|policy)\b/,
  /\b(change|reset|update) (my |your |the )?password\b/,
  /\bcreate (a |an |my |new )?account\b/,
  /\bsign (the )?(contract|agreement|document|lease)\b/,
  /\b(accept|agree to) (the )?(contract|agreement|offer|quote|lease|loan)\b/,
  /\bi agree and (sign|submit|pay|continue to payment)\b/,
  /\bsend (a |the )?(message|email|inquiry|enquiry|request|invitation|invite)\b/,
  /\bpost (a |the )?(comment|reply|review|message)\b/,
  /\bmake (a )?(payment|donation|bid|offer)\b/,
  /\bplace (a )?bid\b/,
  /\bstart (my |your )?(free )?trial\b/,
  /\bupgrade (now|plan|my plan|subscription)\b/,
];

/** Decide whether clicking a control with this visible name is allowed. */
export function checkClickName(name: string): PolicyVerdict {
  const n = normalize(name);
  if (!n) return ALLOW;
  if (n.length <= 40 && DANGEROUS_EXACT.has(n.replace(/[^a-z0-9 ]/g, "").trim())) {
    return { allowed: false, code: "ACTION_REQUIRES_AUTHORIZATION", reason: `Clicking "${name.trim().slice(0, 60)}" could create a financial, destructive, or legally binding effect.` };
  }
  if (DANGEROUS_PHRASES.some((re) => re.test(n))) {
    return { allowed: false, code: "ACTION_REQUIRES_AUTHORIZATION", reason: `Clicking "${name.trim().slice(0, 60)}" could create a financial, destructive, or legally binding effect.` };
  }
  return ALLOW;
}

export interface FieldInfo {
  tag: string;
  type: string;
  autocomplete: string;
  name: string;
  id: string;
  placeholder: string;
  label: string;
}

const SENSITIVE_AUTOCOMPLETE = /^(cc-|current-password|new-password|one-time-code)|\b(cc-number|cc-csc|cc-exp)/;
const SENSITIVE_FIELD_HINT =
  /(passw|passcode|pass_?phrase|\bpin\b|otp|one.?time|card.?(number|no|num)|cc.?num|credit.?card|cvv|cvc|ccv|security.?code|iban|swift|routing|account.?(number|no)|sort.?code|ssn|social.?security|tax.?id|passport|seed|mnemonic|recovery.?phrase|private.?key|secret|api.?key|token)/i;

/** Refuse typing into password/payment/secret fields. */
export function checkFieldForTyping(field: FieldInfo): PolicyVerdict {
  const type = field.type.toLowerCase();
  if (type === "password") {
    return { allowed: false, code: "SENSITIVE_INPUT_REJECTED", reason: "Typing into password fields is not allowed." };
  }
  if (type === "file") {
    return { allowed: false, code: "SENSITIVE_INPUT_REJECTED", reason: "File inputs are not allowed; Act402 never uploads files." };
  }
  if (SENSITIVE_AUTOCOMPLETE.test(field.autocomplete.toLowerCase())) {
    return { allowed: false, code: "SENSITIVE_INPUT_REJECTED", reason: "Typing into payment or credential fields is not allowed." };
  }
  const hints = [field.name, field.id, field.placeholder, field.label].join(" ");
  if (SENSITIVE_FIELD_HINT.test(hints)) {
    return { allowed: false, code: "SENSITIVE_INPUT_REJECTED", reason: "This field looks like a password, payment, or secret field; typing into it is not allowed." };
  }
  return ALLOW;
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\b0x[0-9a-fA-F]{64}\b/, "a private key"],
  [/^[0-9a-fA-F]{64}$/, "a private key"],
  [/\b(sk|rk)_(live|test)_[0-9a-zA-Z]{16,}/, "an API key"],
  [/\bsk-(ant-|proj-)?[0-9A-Za-z_-]{20,}/, "an API key"],
  [/\b(ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{30,}|\bgithub_pat_[0-9A-Za-z_]{40,}/, "an access token"],
  [/\bxox[abposr]-[0-9A-Za-z-]{10,}/, "an access token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "a cloud access key"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "an API key"],
  [/\beyJ[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}/, "an authentication token"],
  [/^bearer\s+\S{16,}/i, "an authentication token"],
];

/** Refuse values that look like card numbers, keys, seed phrases, or tokens. */
export function checkTypedValue(value: string): PolicyVerdict {
  const text = value.trim();
  if (!text) return ALLOW;
  for (const [re, what] of SECRET_PATTERNS) {
    if (re.test(text)) {
      return { allowed: false, code: "SENSITIVE_INPUT_REJECTED", reason: `The value looks like ${what}; Act402 never types secrets.` };
    }
  }
  const digitRuns = text.match(/(?:\d[ -]?){13,19}/g) ?? [];
  for (const run of digitRuns) {
    const digits = run.replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      return { allowed: false, code: "SENSITIVE_INPUT_REJECTED", reason: "The value looks like a payment card number; Act402 never types payment details." };
    }
  }
  const words = text.toLowerCase().split(/\s+/);
  if ([12, 15, 18, 21, 24].includes(words.length) && words.every((w) => /^[a-z]{3,8}$/.test(w))) {
    return { allowed: false, code: "SENSITIVE_INPUT_REJECTED", reason: "The value looks like a wallet seed phrase; Act402 never types secrets." };
  }
  return ALLOW;
}

// Goal-mode screening: refuse goals whose purpose is a forbidden effect.
const GOAL_FORBIDDEN: Array<[RegExp, "ACTION_REQUIRES_AUTHORIZATION" | "POLICY_VIOLATION", string]> = [
  [/\b(bypass|solve|crack|defeat|get (past|around)|circumvent)\b.{0,30}\b(captcha|recaptcha|hcaptcha|paywall|bot (check|protection|detection)|login|authentication|rate limit|cloudflare)/i, "POLICY_VIOLATION", "Act402 does not bypass CAPTCHAs, paywalls, logins, or bot protection."],
  [/\b(steal|harvest|phish|exfiltrate|dump)\b.{0,30}\b(password|credential|cookie|token|session|keys?)/i, "POLICY_VIOLATION", "Act402 does not collect credentials or secrets."],
  [/\b(buy|purchase|order|checkout|check out|pay for|place an? order)\b/i, "ACTION_REQUIRES_AUTHORIZATION", "Purchasing or paying requires explicit authorization; Act402 only reads and navigates."],
  [/\b(transfer|send|withdraw|swap|bridge|stake|deposit)\b.{0,25}\b(money|funds|payment|crypto|tokens?|usdc|usdt|eth|btc|xdc|\$\d)/i, "ACTION_REQUIRES_AUTHORIZATION", "Moving money or crypto is never performed by Act402."],
  [/\b(delete|erase|remove|close|deactivate|cancel)\b.{0,25}\b(account|subscription|membership|profile|data|order|booking|reservation)\b/i, "ACTION_REQUIRES_AUTHORIZATION", "Destructive or cancelling actions are not performed by Act402."],
  [/\b(book|reserve)\b.{0,20}\b(it|them|room|rooms|table|flight|flights|ticket|tickets|appointment|seat|seats|hotel|stay|now)\b/i, "ACTION_REQUIRES_AUTHORIZATION", "Booking or reserving creates a commitment; Act402 only reads and navigates."],
  [/\b(and|then)\s+(pay|checkout|check out)\b/i, "ACTION_REQUIRES_AUTHORIZATION", "Paying requires explicit authorization; Act402 only reads and navigates."],
  [/\b(sign up|register for an account|create an? account|change (my |the )?password|reset (my |the )?password)\b/i, "ACTION_REQUIRES_AUTHORIZATION", "Account creation and credential changes are not performed by Act402."],
  [/\b(sign|accept|agree to)\b.{0,20}\b(contract|agreement|terms of (sale|service)|lease|loan)\b/i, "ACTION_REQUIRES_AUTHORIZATION", "Accepting legally binding agreements is not performed by Act402."],
  [/\b(log ?in|sign ?in)\b.{0,30}\b(with|using) (my |the )?(password|credentials)/i, "ACTION_REQUIRES_AUTHORIZATION", "Act402 does not log in with credentials."],
];

// A goal that only *asks about* prices ("find the price to buy X") is fine; these
// read-only cues keep the screening from refusing ordinary research questions.
const READ_ONLY_CUE = /\b(find|check|look up|lookup|what is|what's|how much|tell me|return|get|show|list|compare|price|cost|available|availability|in stock)\b/i;

export function checkGoal(goal: string): PolicyVerdict {
  for (const [re, code, reason] of GOAL_FORBIDDEN) {
    if (!re.test(goal)) continue;
    if (code === "ACTION_REQUIRES_AUTHORIZATION" && READ_ONLY_CUE.test(goal) && !/\b(and|then)\s+(buy|purchase|pay|order|checkout|transfer|send|delete|cancel|sign|book|reserve)\b/i.test(goal) && !/^\s*(buy|purchase|pay|order|transfer|send|delete|cancel|sign|book|reserve)\b/i.test(goal)) {
      continue;
    }
    return { allowed: false, code, reason };
  }
  return ALLOW;
}
