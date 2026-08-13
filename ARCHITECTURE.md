# Architecture

## Target

The application is a modular monolith. Features stay independently testable
without adding a frontend framework or distributed services to the Home
Assistant add-on.

## Frontend dependency direction

```text
bootstrap -> controllers -> services -> HTTP/WebSocket
    |             |
    v             v
  views <------ state/actions/selectors -> domain models
```

- Domain modules do not access `window`, `document`, network, or timers.
- Services own external effects.
- Controllers coordinate services, state actions, and views.
- Views own DOM creation and event binding but never call HTTP directly.
- `app.js` is the browser composition root and coordinates the remaining DOM
  views; reusable behavior lives in domain, controller, service, canvas,
  property, configuration, glow-line, and viewer modules.
- Cross-feature state changes use named actions.

## Backend dependency direction

```text
app factory -> API routers -> services -> stores/adapters
```

- `backend/app.py` owns application creation, middleware, lifespan, and router
  registration.
- Routers translate protocols and delegate to services.
- Services and stores do not depend on FastAPI request objects.
- Shared request dependencies live below `backend/api/`.

## Quality gates

- Pure logic and controller contracts have unit tests.
- Critical user journeys have isolated Playwright tests.
- Every production JavaScript module is checked in TypeScript strict mode;
  the architecture gate discovers modules recursively, so new files cannot
  silently bypass checking.
- Backend coverage remains at or above 83 percent.
- Dependency locks, audit, Ruff, compilation, and container builds run in CI.
- New feature modules stay below 500 lines and controllers below 300 lines;
  generated catalogs, translation tables, and composition roots are measured
  separately.
- The PowerShell and shell workflows are fail-fast and must propagate native
  command failures.

Every migration phase must pass its unit, type, browser, and backend checks.
Existing thresholds may not be weakened to make a phase pass.
