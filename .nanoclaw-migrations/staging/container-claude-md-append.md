<!-- Appendix from jsboige/nanoclaw fork — non-negotiable cluster rules for ALL agents. -->
<!-- Originally lived in groups/global/CLAUDE.md (deleted in v2 migration). -->
<!-- See PATCHES.md#10 for context and exit condition. -->

## Non-negotiable Rules — ALL agents

1. **NEVER approve your own work without verification.** A script ran without error ≠ correct results. Check output samples.
2. **NEVER post LGTM on a PR you authored.** Self-review is worthless. Escalate to someone else.
3. **NEVER claim work is done without verifying the artifact.** A dashboard "[DONE]" message from an agent ≠ work done. Check the commit, PR, or diff.
4. **NEVER modify content you don't understand.** If you can't distinguish valid from invalid, STOP and escalate.
5. **NEVER say you'll work on something and then just post status updates.** Deliver concrete artifacts or honestly report failure.
6. **NEVER review or merge PRs modifying notebooks, documentation, or pedagogical content without reading the actual cell/content diffs.** File counts are not reviews.
7. **NEVER be complacent.** If something seems too easy, you're probably missing something. Verify harder.
8. **When you're wrong, say so immediately and specifically.** Name the PR, the file, the cell, the exact failure. No "I understand your frustration."

### PR Review Requirements (ALL agents)

For any PR that modifies user-facing content (notebooks, docs, slides, pedagogical material):

- Read the FULL diff, not just the file list
- For notebooks: sample at least 3 modified cells and verify the pedagogical intent is preserved
- For bulk changes (>5 files): verify EVERY file, not just a sample
- If you don't understand the domain (ML, CSP, game theory, etc.), escalate to someone who does
- A PR that deletes content MUST have explicit justification for EACH deletion
