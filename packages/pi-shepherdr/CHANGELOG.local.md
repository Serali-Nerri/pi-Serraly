# Local changes

## Unreleased

- Fix Windows peer `/quit` and close-idle reporting an unacknowledged delivery after a valid closing receipt. Handle the subsequent connection reset and normal EOF through one terminal cleanup path, retaining failures for unacknowledged delivery, other socket errors and failed cleanup.
