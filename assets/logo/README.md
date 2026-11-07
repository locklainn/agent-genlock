# Genlock logo

Three square-wave signals locked in step, the same drawing as the Mac app's icon.
Every file here is generated. Do not edit them by hand:

    swift app/scripts/make-icon.swift assets/logo --logo

That script also draws `Genlock.icns` for the app build, from the same geometry, so the logo and the
app icon cannot drift apart.

| file | what it is | use it for |
|---|---|---|
| `genlock-icon.svg` | the full icon: dark rounded tile with the three signals | anywhere that takes SVG: web pages, docs, README badges, slides |
| `genlock-icon-{16,32,64,128,256,512,1024}.png` | the same, rasterised, transparent outside the tile | project and app icons, favicons (16/32), social cards (512/1024) |
| `genlock-mark.svg` | the three signals alone, no tile, transparent background | placing the logo on a background you control, inline with text |
| `genlock-mark-{16,…,1024}.png` | the same, rasterised | as above, where SVG is not accepted |

The mark has no tile behind it, so it needs a background with enough contrast: it suits mid to dark
backgrounds best. On white the orange and teal are light; use the full icon there instead.

Below 32 px the three rows begin to merge. At 16 px prefer the full icon, whose tile keeps the shape readable.

## Geometry

On a 1024 grid, y down:

- tile: 92.16 inset on every side, corner radius 194.56, `#171A21`
- signals: stroke 43.008, round caps and joins, x from 204.8 to 819.2, three periods each
- colours: `#FF8D28` orange, `#00C3D0` teal, `#CB30E0` purple (macOS system colours, light appearance)

The small animated mark in the app's own header (`SignalMark` in `app/Sources/GenlockApp/Theme.swift`)
is a related but separate drawing with its own colours. It is not this logo.
