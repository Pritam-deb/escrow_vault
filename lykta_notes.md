# Lykta — Observations & Improvement Notes

Collected from real usage against the `escrow_vault` program on devnet.

---

## 1. Error code not resolved to name without --ai

**What happened:**
```
lykta error <sig> --cluster devnet
→ Error code: 6000
```
Expected: `NotRecipient (6000)` — the human-readable variant name from `errors.rs`.

**Why it matters:**
The whole point of `lykta error` is to save the manual hex → decimal → grep-in-errors.rs lookup. If the output still shows a raw number, that lookup still has to happen manually.

**Root cause:**
Lykta doesn't have access to the program's IDL at runtime, so it can't map custom error codes to variant names.

**Possible fix:**
- Parse the on-chain IDL (Anchor programs store it in a buffer account at `programId` — derivable). Custom error names and codes are embedded there.
- Alternatively, accept an `--idl <path>` flag to load a local IDL file.
- The `--ai` workaround works but requires an external API key, which is a high friction barrier for a basic feature like error name resolution.

---

## 2. `lykta inspect` CPI tree and token diffs are genuinely useful — even without --ai

**What the output showed:**
```
CPI Call Tree
▶ 9gsQ8...  ✗

Token Diffs
  vault ATA    +0.000000
  recipient ATA +0.000000
```

**Why this is valuable:**
- Flat CPI tree (no child nodes) + zero token diffs = error fired before the SPL Token CPI was reached. You know immediately it was a `require!` check at the top of the handler, not a downstream CPI failure.
- No need to read raw logs and mentally trace execution flow.

**Contrast with a CPI failure (e.g. bad PDA bump):**
- The tree would show a second node — the SPL Token program — marked red with `PrivilegeEscalation`.
- Logs alone make this hard to pinpoint; the tree makes it obvious.

**Note:** This is already working well. Worth highlighting in docs/demos as a concrete example of value.

---

## 3. `lykta diff` is the strongest feature for state-change debugging

**Example — Scenario D (arbiter approves, time-lock still blocks):**
- `lykta diff <approve_sig>` would show: `arbiter_approved: false → true`
- `lykta diff <claim_sig>` would show: no state changes (error fired before mutation)
- Side by side: the flag was set, but `unlock_timestamp` was never cleared — immediately explains why the claim still failed.

**This is the clearest demo of Lykta's value** over raw logs. Logs tell you *what error* fired; diff tells you *what state led to it*.

---

## 4. `--ai` flag is behind an API key — high friction for basic features

**Observation:**
The prompt `(Set GEMINI_API_KEY and use --ai for AI-powered fix suggestions)` appears even for simple things like resolving an error code name. That's a feature that should work offline from the IDL, not require an LLM call.

**Suggestion:**
Split the feature surface:
- IDL-resolvable things (error names, account field names) → work without --ai, no API key needed
- Genuine AI analysis (root cause explanation, fix suggestions) → --ai flag, API key required

---

## 5. UX friction: two commands needed for a full picture

**Current flow:**
```
lykta error <sig>    # get the error code
lykta inspect <sig>  # get the CPI tree + diffs
```

**Suggestion:**
A single `lykta debug <sig>` that combines error resolution + CPI tree + account/token diffs in one output. The most common debugging task shouldn't require two separate invocations.

---

## 6. Cluster flag is repetitive

Every command requires `--cluster devnet`. Since devnet is the most common non-local target, consider:
- A config file (`~/.lykta/config.toml` or `.lykta` in the project root) that sets a default cluster.
- Or infer from `Anchor.toml` if present in the working directory.
