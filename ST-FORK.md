# ST fork of navbar-card

Branch **`st-navbar`** = upstream's latest release + ST's changes (they were a patch on the built file until 2026-10-28):

1. the media player in a `.media-player-wrapper` (glass + drop shadow; the card inside clips)
2. tabs: unselected icon colour; overflow visible + room for the colour strip
3. a badge colour string becomes a strip of dots (`.badge.badge-multi .badge-dot`), one per comma-separated colour;
   no `Color.from` crash on CSS variables
4. that strip drawn after the label, outside the `.button`
5. player previous / shuffle / repeat buttons (hidden unless a navbar's styles show them); Cupertino (`ios:`) icons
6. carousel: a 48 px drag or a flick switches; counts only the players shown; `--st-slide-w` / `--st-peek`; `.at-end`
7. the next player's artwork as a round button beside the carousel (`.media-player-next`)
8. `popup_style: native`: a route's popup as the system's menu (on iOS its pop-up menu), popup items' `section` as
   headings, the current one checked. A tap's popup: an invisible `<select>` over the route, the tap itself opening
   it (iOS's web view won't open one from script). A hold's: a `<select>` over the button shown with `showPicker()`,
   as the finger lifts; the card's own popup where the system's can't open
9. `popup_style: menu`: a route's popup drawn as iOS's menu (`st-menu.ts`) - frosted, grown from its button, the
   current item checked, popup items' `section` as headings and their new `detail` as a second line, icons on the
   right. Opens on the press (a tap's on pointerdown, a hold's as it fires); drag along it to light a row (a
   `haptic` `selection` tick per row, played by Home Assistant's app) and lift to choose; lifted on the button it
   stays open to tap; a tap outside closes it

**Updates:** `.github/workflows/st-sync.yml` merges each new upstream release daily, builds, runs upstream's tests and
`st-tests/`, and publishes `vX.Y.Z-st.N`. Home Assistant's `update.navbar_card_st_fork` (custom integration
`st_navbar`) installs it; `st_navbar.rollback` puts the previous build back. A conflict or a failing test opens an
issue and releases nothing.
