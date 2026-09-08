# Payment example

`pay(charge, sleep)` attempts a payment at most three times in total: one initial
attempt and up to two retries. Only `NETWORK_ERROR` triggers a retry, with a
five-second delay between attempts. A declined card is not retried.

Example questions:

- What happens when a payment fails?
- Is this three attempts or three retries?
- Draft a Node.js test for a declined card, using the supplied implementation.

This is fictional example code, not a production payment integration.
