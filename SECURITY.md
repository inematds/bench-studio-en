# Security

Bench Studio Public is designed as a local, single-user application.

## Safe default deployment

- Keep the API bound to loopback.
- Store keys in `~/.env`, never in source files or Vite variables.
- Do not commit `data/`, `.env`, logs, reports, generated projects, or media.
- Review generated website and document source before publishing it.
- Keep Node.js, Chrome, and dependencies current.

## Not a public web service

The local API does not implement accounts, tenant isolation, rate limiting, or
internet-facing authentication. Do not bind it to a public interface, expose it
through a tunnel, or deploy it to a shared host without adding those controls
and completing a security review.

## External providers

Media generation sends the submitted prompt and selected reference files to the
configured provider. Provider retention and training policies are outside this
repository. Do not submit sensitive media without reviewing the provider's
current terms.

## Reporting a vulnerability

If this package is published in a public repository, configure a private
security-reporting channel in that repository before announcing the release.
Do not include secrets, personal media, or exploit payloads in a public issue.
