# judgment-review-extraction Specification

## Purpose

Defines how a planning review whose reviewer did not return the required structured object is recovered by classifying the reviewer's own words instead of asking again, and how such a recovered review is marked.

## Requirements

### Requirement: Extraction is attempted before a corrective retry

When a reviewer's response is not valid structured output at all, an extraction SHALL be attempted before the corrective retry and, on the final attempt, before the review fails. A response that is valid structured output, including one that is structurally valid but rejected for its content, SHALL NOT be sent for judgment.

#### Scenario: Unparseable response is extracted before retrying

- **WHEN** the reviewer's first response is prose and judgment is available in enforce mode
- **THEN** an extraction is attempted before any corrective retry is sent

#### Scenario: Valid structured response is never judged

- **WHEN** the reviewer's response is valid structured output, or is structured output rejected for its content
- **THEN** no judgment request is sent for it

#### Scenario: Final attempt tries extraction before failing

- **WHEN** the final attempt's response is prose and no extraction has succeeded
- **THEN** an extraction is attempted before the review is failed

### Requirement: Extracted findings are the reviewer's own words

Every finding in an extracted review SHALL be a line taken from the reviewer's response, changed only by removing list markers and normalizing whitespace to a single line. No finding text SHALL be generated. Candidates SHALL be list items with their continuation lines and standalone paragraphs, each carrying the nearest preceding heading, at most 60 candidates of at most 400 characters each. A response exceeding either limit SHALL NOT be extracted.

#### Scenario: Findings are verbatim lines

- **WHEN** an extraction is accepted
- **THEN** each critical finding, required change, and recommendation equals a candidate line from the reviewer's response after marker removal and whitespace normalization

#### Scenario: Too many candidates skips extraction

- **WHEN** a response yields more than 60 candidate lines or a line longer than 400 characters
- **THEN** extraction is not attempted and the retry proceeds as today

### Requirement: Extraction is accepted only when confident and consistent

An extraction SHALL be accepted only when the verdict has confidence of at least 0.8 and is not unclear, every candidate line is classified with confidence of at least 0.8, and the verdict is consistent with the findings: an approval has no line classified as critical or required, and a revise has at least one. Any other extraction SHALL be not accepted.

#### Scenario: Confident consistent extraction is accepted

- **WHEN** the verdict is revise at 0.9, every line is classified at 0.85 or higher, and at least one line is classified required
- **THEN** the extraction is accepted and the review is assembled from the classified lines

#### Scenario: Uncertain line rejects extraction

- **WHEN** any candidate line is classified with confidence below 0.8
- **THEN** the extraction is not accepted

#### Scenario: Approve with a blocking line is rejected

- **WHEN** the verdict is approve and any line is classified critical or required
- **THEN** the extraction is not accepted

#### Scenario: Revise without a blocking line is rejected

- **WHEN** the verdict is revise and no line is classified critical or required
- **THEN** the extraction is not accepted

#### Scenario: Unclear verdict is rejected

- **WHEN** the verdict is unclear, or its confidence is below 0.8
- **THEN** the extraction is not accepted

### Requirement: An unaccepted extraction retries exactly as today

When an extraction is not accepted, the corrective retry SHALL be sent with the same message, the same session, and the same attempt limit as without judgment, and a final failure SHALL raise the same error.

#### Scenario: Unaccepted extraction retries as today

- **WHEN** an extraction is not accepted on the first attempt
- **THEN** the corrective retry is identical to the retry sent without judgment

### Requirement: Empty responses cannot be extracted

A response with no candidate lines SHALL be retried as today, and no judgment request SHALL be sent for it.

#### Scenario: Empty response is retried

- **WHEN** the reviewer's response is empty or has no candidate lines
- **THEN** no judgment request is sent and the corrective retry proceeds

### Requirement: Extracted reviews are marked

A persisted review artifact produced from an extraction SHALL record that it was extracted and SHALL reference the decision record. A review artifact without the mark SHALL remain valid and SHALL be read as not extracted. Rendering and reading a marked artifact SHALL round-trip.

#### Scenario: Extracted review carries its provenance

- **WHEN** a review is persisted from an accepted extraction
- **THEN** the artifact records that it was extracted and names the decision record, and reading it back yields the same mark

#### Scenario: Review without the marker still parses

- **WHEN** a review artifact written before this capability is read
- **THEN** it parses successfully and is treated as not extracted

### Requirement: Shadow mode extracts and compares without acting

In shadow mode the corrective retry SHALL proceed exactly as without judgment. The extraction SHALL be recorded and, once the retry's result is known, reconciled with it, recording whether the verdicts agree. Agreement and the rate at which extraction would have been accepted SHALL be reportable.

#### Scenario: Shadow extraction never replaces the retry

- **WHEN** judgment runs in shadow mode and an extraction would have been accepted
- **THEN** the corrective retry is sent and its result is the review's result

#### Scenario: Agreement is reported

- **WHEN** the records of several shadow-mode extractions are summarized
- **THEN** the report gives the rate at which extraction would have been accepted and the rate at which its verdict agreed with the retry's

### Requirement: Unavailable judgment yields today's behavior

For every unavailable reason the reviewer runner SHALL behave exactly as without judgment. When judgment is disabled, no judgment work SHALL be performed.

#### Scenario: Every unavailable reason retries as today

- **WHEN** judgment is unavailable for any reason, including budget, timeout, invalid response, and model mismatch
- **THEN** the corrective retry and final failure are identical to those without judgment

#### Scenario: Disabled judgment adds no work

- **WHEN** judgment is disabled
- **THEN** no request is sent, no record is written, and the reviewer runner behaves as it does without judgment

### Requirement: Reviewer audits are unchanged

An extracted review SHALL be subject to the same reviewer selection, the same audit of the tools the reviewer used, and the same validation as a review parsed from structured output.

#### Scenario: Extracted review is audited and validated like any other

- **WHEN** a review is produced by an accepted extraction
- **THEN** the reviewer's tool use is audited, a reviewer that used a non-read-only tool still fails the review, and the assembled review is validated against the same schema

### Requirement: Extraction egress is documented

The security documentation SHALL list, for this decision, the state that leaves the machine: the reviewer's response text and its candidate lines.

#### Scenario: Security documentation lists the extraction egress

- **WHEN** the security documentation's per-call-site table is read
- **THEN** it has a row for review extraction naming exactly that state
