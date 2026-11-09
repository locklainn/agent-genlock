## Phone builds: only on a phone the user names

A phone the machine can reach is not permission to install on it.

    ./phone.sh --list                      # the phones in reach
    ./phone.sh --device NAME [--device ..] # build and install on those, in that order
    ./phone.sh android --build-only        # build only; the download-link script uses this

- **Ask which phone every time** someone says deploy, push or install to a phone, then pass exactly those with `--device`. Never pick one, never install on everything in reach.
- **A block from the phone-install guard means stop and ask.** Never route around it: no script that calls `adb install` or `devicectl`, no renamed copy of `phone.sh`.
- Setup, signing and the download link are in the `phone-builds` skill.
