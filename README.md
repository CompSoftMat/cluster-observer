# Cluster Observer

Researchers who work across more than one server or cluster might often ask: where should the next job go? Checking queue state machine by machine gets tedious quickly. 

Cluster Observer is a small Python dashboard for that use case. Given a machine with access to the relevant clusters, it connects to each one, filters jobs by configured scheduler fields, and presents the result in a browser.

The project is fairly lightweight:
- python standard library backend
- simple static frontend

Assumptions:
- host machine has `ssh` access to the relevant servers
- `ssh` keys are registered for automatic login
- server/cluster uses a PBS scheduler for running jobs, i.e. commands such as `qstat` is exposed


## Features

For each configured cluster, the dashboard displays jobs with:
- job ID
- owner username
- job state
- submit time
- queue
- GPU count
- used walltime
- requested walltime
- scheduled start time, when exposed by the scheduler

The browser UI is built around one cluster-wide job table plus live filters:
- quick preset buttons derived from configured `filter_groups`
- interactive filtering by user, queue, state, and project
- summary cards and top-user / top-queue breakdowns
- client-side search, sorting, and pagination for large job sets

Other "privacy" features:
- private runtime config loaded from `~/.config/cluster-observer/config.toml`
- Host/IP values shown in the browser are masked before they reach the frontend.
- This repository does not need to contain real cluster hosts, usernames, project codes, or SSH credentials. You can fork it.

> [!NOTE]
> Cluster Observer is deliberately an internal tool. It is meant for small-group or personal use in environments. Although it is built to never expose relevant infomation, use it to your own risk.

## Scheduler Support

Current support is intentionally limited to PBS-style `qstat -f` output, because that is the scheduler environment this tool was written around and used against. The parsing, displayed fields, and assumptions in the dashboard all follow that workflow.

Some PBS deployments expose job arrays or batched jobs only when `qstat` is called with extra flags such as `-t`. Cluster Observer supports that through per-cluster `qstat_args`.

Broader scheduler support may be added later if there is a concrete need for it. Support for other systems should be treated as future work rather than current functionality.

## Config

Runtime configuration lives in `~/.config/cluster-observer/config.toml`.

A generic example is included at [config.example.toml](/home/holo/projects/cluster-observer/config.example.toml):

```toml
[server]
dashboard_title = "Your Group Cluster Status"
host = "0.0.0.0"
port = 8080
refresh_seconds = 30
request_timeout_seconds = 20

[[clusters]]
name = "cluster-a"
host = "login.cluster-a.example"
user = "your-username"
ssh_options = ["-o", "BatchMode=yes"]
qstat_args = ["-f"]

[clusters.filter_groups.project]
project = ["your-project-code"]

[clusters.filter_groups.free_queue]
queue = ["free"]

[[clusters]]
name = "cluster-b"
host = "login.cluster-b.example"
user = "your-username"
ssh_options = ["-o", "BatchMode=yes"]
qstat_args = ["-t", "-f"]

[clusters.filter_groups.project]
project = ["your-project-code"]
```

Configuration notes:
- `dashboard_title` controls the browser tab title and main page heading.
- `filter_groups` is optional. When provided, each named group becomes a one-click preset in the dashboard.
- Inside a group, each key should match a parsed `qstat -f` field such as `project`, `queue`, `user`, or `state`.
- Filter values may be either a single string or a list of strings. A job must satisfy all filters inside a group to appear in that group.
- If no `filter_groups`, legacy `filters`, or `project` are configured, the cluster defaults to an `all jobs` preset.
- Legacy `filters = ...` and `project = "..."` are still accepted and are mapped into a default group for backward compatibility.
- `user` defaults to the local `$USER` if omitted.
- `qstat_args` defaults to `["-f"]`. For clusters where you want PBS arrays or batched jobs expanded into member jobs, try `["-t", "-f"]`.
- SSH keys must already be configured. The app does not manage passwords or interactive prompts.

## Install

```bash
python3 -m pip install -e .
```

## Run

```bash
cluster-observer
```

The default dashboard address is `http://<host>:8080/`.

Config path and bind address may be overridden:

```bash
cluster-observer --config ~/.config/cluster-observer/config.toml --host 0.0.0.0 --port 8080
```

## Security

All relevant information is kept in the private config file.

The running dashboard is a separate concern. A live instance exposes scheduler metadata for matching jobs, including usernames, job IDs, queue names, GPU counts, and timing information. Environments where that data is not meant to be public should place the app behind authentication or a network restriction rather than exposing it directly to the internet.
