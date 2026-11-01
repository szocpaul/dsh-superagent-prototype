# Operator Steps: Agent Account and Test Repository

These steps are for the human operator. They prepare the identities the Prime
Runner Bridge needs. Nothing here is automated by the agent: the agent never
requests, stores, or transmits a secret, and never asks for one in a conversation.

## 1. The agent account

The bridge controller needs a GitHub identity that is **not** the human approver.
This follows the upstream deployment guide, and the GitHub Source requires it:
the source drops the messages of the agent account, so one shared account would
hide the operator's requests and approval as well as weaken the audit trail.

- Create a GitHub user account for the agent, for example
  `szocpaul-dsh-agent`. Give it write access to the working repository only.
  A GitHub App cannot be the agent, because dsh-superagent reads the account's
  notifications.
- Keep it separate from the human approver account. The bridge's gate protocol
  requires a human decision and a controller action to be attributable to
  different accounts.
- Create the account with the name only; no organisation, no team, and no
  other repository access. The account needs no email inbox of its own beyond
  the one GitHub requires for registration.

## 2. A separate CLI configuration for the agent

The agent's CLI must use only the agent's credentials. Use a separate
configuration directory so the human's own `gh` login stays untouched:

```sh
mkdir -p ~/.local/bin
cat > ~/.local/bin/gh-agent <<'EOF'
#!/bin/sh
GH_CONFIG_DIR="$HOME/.config/gh-agent" exec gh "$@"
EOF
chmod +x ~/.local/bin/gh-agent
gh-agent auth login
gh-agent api user --jq .login
```

The last command prints the agent's login. Use exactly this login wherever the
deployment asks for the agent account. Never reuse the human account's token.

Git commands need the same identity. Give them an isolated configuration file
instead of changing the operator's global Git setup, the way the deployment
guide does for the worker environment:

```sh
cat > ~/.config/gh-agent/gitconfig <<'EOF'
[credential "https://github.com"]
	helper = !/home/ubuntu/.local/bin/gh-agent auth git-credential
EOF
```

Use it per command:

```sh
GIT_CONFIG_GLOBAL="$HOME/.config/gh-agent/gitconfig" GIT_CONFIG_NOSYSTEM=1 git push
```

Without it, Git resolves the operator's own credential helper first and pushes
under the operator's account.

Do not store the token in this repository, in a prompt, in a report, or in a
specification. The file under `~/.config/gh-agent` holds it.

## 3. Granting the agent write access

After the account exists, invite it to the working repository:

```sh
gh api -X PUT repos/szocpaul/dsh-superagent-prototype/collaborators/szocpaul-dsh-agent \
  -f permission=push
```

The permission is `push`, not `admin` and not `maintain`. The agent needs to
create branches and open pull requests. It must not be able to change the
branch rules, and it must not be able to merge: the protected `main` refuses a
merge by the account that pushed the branch, and refuses an administrator
merge as well. GitHub sends this as an invitation for an outside account, so
the agent account must accept it once, signed in as itself.

Verified on 2026-11-01: the agent's pull request could not be merged, not even
with administrator privileges, and the operator's merge was refused until the
operator approved the pull request.

Verify the result:

```sh
gh api repos/szocpaul/dsh-superagent-prototype/collaborators/szocpaul-dsh-agent \
  --jq '{login, permissions}'
```

The `permissions` object must not contain `admin: true` or `maintain: true`.

## 4. The working repository and its branch rules

The development repository is the operator's fork of the upstream research
prototype:

```text
origin    szocpaul/dsh-superagent-prototype        (the fork; the working repository)
upstream  deepseek-ai/dsh-superagent-prototype     (the upstream prototype)
```

The `main` branch of the fork is protected: a pull request is required, one
approval is required, the rule applies to administrators, and the last pusher
cannot approve their own pull request. Verified on 2026-11-01 with a temporary
pull request: merging as the agent account was refused, merging with
administrator privileges was refused, and pushing directly to `main` was refused.

The agent account therefore opens pull requests and pushes branches; a human
account performs the merge.

## 5. What the operator does during a gate

The human performs the gate action through the GitHub web interface on the
Ticket branch:

1. Review the evidence in the draft pull request.
2. Edit exactly one line of the task list: the pending gate's checkbox from
   `[ ]` to `[x]`. Do not change any other line.
3. Commit the edit on the Ticket branch.
4. Post the gate decision in the original Ticket conversation, mentioning the
   agent and naming the gate and the commit:

   ```text
   @<agent login> APPROVE GATE <gate id> <manifest sha256> <full gate commit sha>
   ```

A web edit made through the GitHub interface is signed by GitHub, and the API
reports the acting account as the commit author. Commits pushed from a machine
are unsigned. The bridge requires the signed, attributable form.

**Never** let the agent write the gate checkbox itself, and never approve a
gate in the agent's name.

## 6. What the operator approved for the T054 smoke

The operator approved part 1 of the disposable smoke on 2026-11-01: the host
starts alone, with no model call and no GitHub write. It ran and passed; see the
runner report's section 4c.

The deployment it produced:

| Item | Value |
| --- | --- |
| DSH host | `@deepseek-ai/dsh` 0.2.1-rc.3, the version the deployment guide pins |
| Profile | `superagent`, webserver on 127.0.0.1:3082 |
| State directory | `/home/ubuntu/.dsh/state/superagent` |
| GitHub Source | repository `szocpaul/dsh-superagent-prototype`, agent CLI `/home/ubuntu/.local/bin/gh-agent` |
| Agent account | `szocpaul-dsh-agent` |
| GitHub CLI | 2.103.3 from the official release, first on the user's path |

Two things were fixed to make it run: the service script did not recognize the
service process when `ps` reported the thread name, and the installed GitHub CLI
was older than the documented 2.48 and did not support `--slurp`.

Parts 2 and 3 of the smoke are still unapproved and unstarted.

## 7. Cleanup

The probe pull request and its branch were removed after the check. If a later
probe is needed, delete its branch and close its pull request afterwards.
