---
schema_version: 1
id: public-launch-package
created_at: 2026-09-01
created_by: RubiksCubingGod
slice:
  kind: vertical
  entry: A judge or stranger encountering the launch post on LinkedIn or X
  terminal: >-
    They can watch the demo, read the story, land on the public repo, understand the
    architecture, and reproduce the setup - with the post live, tagging @harrychow_ and
    @getsolari, published from Aarav's accounts with his approval
origin:
  summary: The public face - repo flipped public after a recorded secrets audit, the README
    and architecture writeup, the sub-three-minute consequence demo, and the launch post the
    challenge is judged on.
  refs: [.nah/active/challenge-launch/README.md,
    .nah/active/challenge-launch/specs/production-deploy.md]
---

# Public launch package

## Outcome

Four artifacts, one path through them. The repo goes public under the chosen name after a
recorded full-history secrets audit (tooling-assisted scan plus manual review of flagged
commits; a found leak means rotate-then-rewrite before the flip). The README sells and
serves: what the product does, the demo, the architecture writeup (the seam invariant, the
provider seam, the guardrail posture, the fixture-first proof strategy - the engineering
story the judges reward), and the verified setup path. The demo recording follows the
consequence spine - real change detected, Telegram confirm, cancellation mission, rrweb
replay - under three minutes. The launch post (LinkedIn + X variants) tells the
build-in-public story, embeds the demo, links the repo, and tags @harrychow_ and @getsolari;
copy drafted for Aarav's approval, sent by him.

## Path

Audit → flip public → README/writeup land → demo recorded against production → post drafted →
Aarav approves → published with tags → post links resolve: demo plays, repo renders, setup
reproduces.

## Failure behavior

Any audit finding blocks the flip until rotated and rewritten, recorded. A demo take that
requires editing around a product failure is not a take - the failure goes back to its
owning sprint first. Post variants respect each platform's link/media handling so the demo
is watchable in-feed where possible; if a tag handle has changed, the current handle is
verified against the challenge brief before publishing.

## Proof

The committed audit record; the public repo rendering correctly (README, badges, no broken
links) checked from a logged-out browser; the demo file and its embed playing from the post;
the published post URLs recorded in the repo; the fresh-clone setup verification cited from
production-deploy.
