# Test Matrix

| Proof | Spec | Layer | Where it runs |
|---|---|---|---|
| Trigger atomicity: observation + enqueue + pause commit together; fresh-check re-arm | slot-snipe-path | unit | every push |
| Released slot → exactly one enqueue, watch paused; re-run enqueues nothing | slot-snipe-path | integration (fakedmv, LocalProvider) | every push |
| Booked path: fixture booking record, confirmation reference on task, notification | slot-snipe-path | integration (scripted UserIO) | every push |
| Confirm gate: decline cancels; auto_book skips the ask | slot-snipe-path | integration | every push |
| Slot-yank race → refused-slot-gone, watch re-armed, notified; later release books | slot-snipe-path | integration (control-plane yank) | every push |
| Blocked mode → mission fails, watch stays paused, user notified | slot-snipe-path | integration | every push |

The fixture control plane's slot-yank hook makes the race deterministic; success is defined by
the fixture's booking record plus stored reference, never by flow completion. Real booking
sites are s9.
