# Project Instructions

## Build Commands

- `npm run dev` is the normal development launch and must use the historical persistent Electron `userData` profile derived from the package name `agent-cockpit`, plus the default persistent tmux/mux resources. This intentionally differs from the packaged app's `Agent Cockpit` profile because existing development projects are stored under the historical name. Do not pass a temporary `--user-data-dir` or redirect profile/session storage in the default dev command. Do not migrate, replace, or delete either profile without explicit authorization.
- Development and test launches that need isolation must use an explicit isolated command or option. They must identify their temporary profile, tmux socket, and mux home as belonging only to that invocation.

## Code Style

- Process cleanup must be scoped to processes and temporary resources created by the current explicit isolated run. Never remove or replace an existing user profile, `store.db`, settings file, or persistent session data as part of normal development startup or shutdown.
