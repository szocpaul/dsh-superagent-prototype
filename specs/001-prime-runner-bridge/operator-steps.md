# Operator Steps: Agent Account and Test Repository

These steps are for the human operator. They prepare the identities the Prime
Runner Bridge needs. Nothing here is automated by the agent: the agent never
requests, stores, or transmits a secret, and never asks for one in a conversation.

## 1. The agent account

The bridge controller needs a GitHub identity that is **not** the human approver.
This lets the branch rules distinguish the two, and it keeps the agent's writes
visibly separate from a person's decisions.

- Create a GitHub user account for the agent, for example
  `szocpaul-dsh-agent`. Give it write access to the working repository only.
  A GitHub App cannot be the agent, because dsh-superagent reads the account's
  notifications.
- Keep it separate from the human approver account. The bridge's gate protocol
  requires a human decision and a controller action to be attributable to
  different accounts.

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

Do not store the token in this repository, in a prompt, in a report, or in a
specification. The file under `~/.config/gh-agent` holds it.

## 3. The working repository and its branch rules

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

## 4. What the operator does during a gate

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

## 5. Cleanup

The probe pull request and its branch were removed after the check. If a later
probe is needed, delete its branch and close its pull request afterwards.
