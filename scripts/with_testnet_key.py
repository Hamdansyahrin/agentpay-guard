#!/usr/bin/env python3
"""Run a command with QIE_DEPLOYER_KEY set from the local testnet wallet file.

The key is read in-process and passed via the environment only — it is never
printed. The wallet file (.qie-testnet-wallet.secret, mode 0600, gitignored)
holds a dedicated throwaway TESTNET wallet; it must never hold real funds.

Usage: python3 scripts/with_testnet_key.py npx hardhat run scripts/deploy.js --network qieTestnet
"""
import os
import re
import sys

SECRET = os.path.join(os.path.dirname(__file__), "..", ".qie-testnet-wallet.secret")


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: with_testnet_key.py <command> [args...]", file=sys.stderr)
        return 2
    key = None
    with open(SECRET) as fh:
        for line in fh:
            m = re.match(r"\s*privateKey\s*:\s*(0x[0-9a-fA-F]{64})\s*$", line)
            if m:
                key = m.group(1)
                break
    if not key:
        print("privateKey not found in wallet file", file=sys.stderr)
        return 1
    env = dict(os.environ, QIE_DEPLOYER_KEY=key)
    os.execvpe(sys.argv[1], sys.argv[1:], env)
    return 1  # unreachable


if __name__ == "__main__":
    sys.exit(main())
