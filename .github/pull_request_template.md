## What & why

<!-- A sentence or two. If this implements an item from docs/next-features.md, name it (HD-NN). -->

## What it looks like

<!--
REQUIRED for any user-visible change: a screenshot or short video of it, staged
so the reader can see the feature doing its job — not an empty default window.
A PR with no UI change says so here in one line instead.

The app captures itself:

    npx electron . --user-data-dir=/tmp/shot-profile \
      --capture=shot.png --capture-delay=6000 \
      --capture-keys=ctrl+shift+u --capture-quit

Seed /tmp/shot-profile/workspaces.json with panes whose commands print the
state you want on screen (`printf '...'; sleep 600` is the whole trick), and
--capture-keys presses the chords that open your overlay. Commit the image
under docs/media/ on the branch and embed it with a raw.githubusercontent URL
pinned to the commit SHA, so it outlives the branch.
-->

## Verification

<!-- Paste the tails, or say which check covers the change. All three must pass. -->

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run smoke`
