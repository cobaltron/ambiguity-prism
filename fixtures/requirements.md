# Retry & Error Handling Requirements (fixture)

2.3 The API shall return HTTP status 404 when the requested resource does not exist.

4.2 The service should retry failed requests up to three times before returning an error.

4.3 The client must close the connection after three attempts in total, counting the first.

5.1 The gateway may compress the response body or encrypt it, depending on the negotiated profile.

5.4 Each request that carries an expired token must be rejected with HTTP status 401.

6.2 The worker shall archive all records that exceed the retention window.

7.1 The system shall respond quickly to user actions.

7.4 The scheduler must process the queued request log before the next window opens.

8.1 The service must emit a metric for every retry, and the metric must include the attempt number.

9.2 The service shall respond within 200 ms at the p99 percentile for all read endpoints.

5.6 The gateway shall forward the request to the primary server, and the worker must retry it after a timeout.
