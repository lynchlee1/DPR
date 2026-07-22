## Behavior Classification Rules
### 1. Purpose
- This document explains how to categorise and describe system behavior using consistent criteria.
- Carefully check the conditions and functions of system behavior to make sure that same behavior doesn't get classified differently across documents.
<br>

Every operation must be able to answer the following three questions:
1. Does it affect the resulting data, or is it the way the UI · API execute?
2. Does it operate under the right conditions, or does it operate after an unexpected failure?
3. Which state transition does it directly control: accepting input, producing a candidate result, or validating and certifying a completed result?

### 2. Rules
- Keep each rule focused on one functionality.
- Each operation is classified according to the following order: **Layer → Behavior → Responsibility**.

#### 2.1 Layer: Core · Serving
- **Layer** separates ownership of the business-result lifecycle from ownership of user and API interaction.
- **Core** accepts domain input and owns the production, validation, certification, and publication of the business result.
  - This category includes rules that determine which business values should be selected or excluded and whether a completed candidate is valid enough to publish.
  - A rule is Core if removing it can change the business result or whether that result is accepted as valid, saved, or published.
- **Serving** determines how the UI and API request and coordinate Core execution and present its progress and results.
  - It may validate a request or response, but it does not produce, change, or certify the document's business result.
  - A rule is Serving if the Core business result and its validity remain the same while only the request, execution control, or presentation changes.
- Within both the Core and Serving categories, behavior should be classified as Feature, Fallback, or Shutdown.

#### 2.2 Behavior: Feature · Fallback · Shutdown
- **Behavior** distinguishes between normal conditions and how failures are handled.
  - First, determine whether it is a feature.
  - Only when it is not a feature, distinguish between fallback and shutdown.
- **Feature** is a set of rules for processing normal input and data.
  - It includes selecting or rejecting values.
  - It includes normal operations creating empty results.
- **Fallback** uses a different value or method, or reduces the processing scope, to continue after an unexpected failure.
- **Shutdown** is a set of rules for when an unexpected failure occurs and it is not possible to produce a safe result, resulting in the current execution ending.

```text
Does it work with normal input and data?
├── Yes: Feature
└── No
    ├── Continue using a different method or with a reduced scope: Fallback
    └── Terminated because a safe result could not be produced: Shutdown
```

- Do not classify it simply because certain items were excluded or because execution was terminated.
  - If processing follows the normal rules, it is a Feature.
  - It is only classified as a Fallback if an unexpected failure occurs and the current execution continues, or as a Shutdown if it is terminated.

#### 2.3 Responsibility: Input Handling · Core Processing · Result Validation
- **Responsibility** identifies how a rule relates to the business result declared by the document.
  - Define the document's external input, business result, and publication boundary before assigning a responsibility. A helper return value, UI state, progress log, preview, or display representation is not a separate business result.
- **Input Handling** accepts, rejects, resets, or prepares data and execution state without producing or changing the declared business result.
  - It includes reading, locating, parsing, normalising, and checking the availability, type, format, schema, and required values of input before business-result production begins.
  - It includes choosing the starting range after rejecting a prior result and requesting, routing, cancelling, formatting, truncating, or displaying Core execution and results in Serving.
  - A file that was a result of an earlier operation and a result returned by Core are inputs when another operation or Serving reads them.
- **Core Processing** turns accepted input into the declared business result or changes that result's business values, membership, relationships, or ordering.
  - It includes domain extraction, selection, exclusion, calculation, transformation, aggregation, linking, result-structure construction, and persistence of business-result values.
  - Core Processing is valid only in the Core layer. A Serving rule does not become Core Processing merely because it starts Core or produces a UI response.
  - A check performed while the candidate result is incomplete is Core Processing only when it determines or changes what the business result contains.
- **Result Validation** examines a completed candidate result and determines whether it may be published, saved as valid, returned, or reused.
  - It includes checking the completed result's structure, completeness, counts, and internal or source consistency.
  - It includes creating validation evidence such as a manifest, validation metadata, warning record, or completion marker when that evidence certifies the completed result without producing or changing its business values.
  - If a rule repairs, substitutes, recalculates, filters, or otherwise changes business-result values, it is not Result Validation.

```text
Does the rule approve, reject, or certify a completed candidate without changing it?
├── Yes: Result Validation
└── No
    ├── Produce or change the declared business result: Core Processing
    └── Accept, reset, route, control, format, truncate, or display without changing it: Input Handling
```

### 3. Boundary Rules
- Core and Serving are distinguished by which lifecycle the rule owns.
  - Producing the business result or deciding whether it is valid and publishable is Core.
  - Requesting or coordinating that work and validating or displaying the interaction response is Serving.
- Feature and Fallback are distinguished by whether the alternative is part of normal processing.
  - Selecting a value according to a predefined order is a Feature.
  - Using another value because the intended value failed is a Fallback.
- Feature and Shutdown are distinguished by why the execution ends.
  - Rejecting valid input according to a normal rule is a Feature.
  - Ending execution because of an unexpected failure is a Shutdown.
- Validation and its failure handling must be written as separate rules.
  - A validation performed during normal processing is a Feature.
  - Continuing with a reduced result after validation fails is a Fallback.
  - Ending execution after validation fails is a Shutdown.
- Excluding an item does not determine the classification by itself.
  - Excluding an item according to a normal rule is a Feature.
  - Excluding a failed item and continuing with the remaining items is a Fallback.
- Responsibility is determined by the role of the data relative to the business result declared by the current document, not by the file name or its role in a previous operation.
  - Validating a prior saved result before reusing it as the current input is Input Handling.
  - Validating a newly completed candidate immediately before publication is Result Validation.
- The business result is declared at the document boundary, not inferred from a helper function or UI component.
  - Formatting, truncating, or displaying a Core result is Serving Input Handling, even when it creates local UI state.
  - Starting, retrying, cancelling, or monitoring Core from Serving is Input Handling. Any resulting business-value change belongs to a separate Core rule.
  - Core Processing must not be used in the Serving layer.
- A recovery trigger and the business processing it invokes are separate rules.
  - Rejecting an invalid prior result and choosing a full reprocessing range is Input Handling.
  - The normal operation that produces the replacement business result remains Core Processing.
- Creating a file does not determine the responsibility by itself.
  - Creating or changing business-result values is Core Processing.
  - Creating a manifest, validation metadata, warning record, or completion marker that certifies an unchanged completed result is Result Validation.
- The words `read`, `check`, `validate`, `save`, `metadata`, and `result` do not determine responsibility. Apply the state-transition test instead.
- A rule must not span more than one responsibility transition.
  - Split input acceptance, result production, and completed-result validation into separate rules.
  - In particular, do not combine validation failure detection, user confirmation, and alternative result production in one rule.
- For every rule, its description should make the boundary observable: name the accepted input, the business result or candidate being acted on, and whether the candidate is incomplete or complete at that point.

### 4. Writing Example
The following example shows valid combinations of Layer, Behavior, and Responsibility. Serving has no Core Processing example because Serving does not change the business result. An actual document should include only the rules that exist and mark an empty category explicitly (`없음` in the disclosure documents).

```markdown
### Core

#### Feature

**[Input Handling] Date Range Validation**
- Accepts a start date that is earlier than or equal to the end date.

**[Core Processing] Record Filtering**
- Selects records that match the accepted date range.

**[Result Validation] Result Certification Metadata**
- After all records have been selected, confirms that the reported count matches the records and writes a completion marker without changing them.

#### Fallback

**[Input Handling] Compatible Input Format**
- Uses a supported legacy input format when the current format cannot be read.

**[Core Processing] Failed Record Exclusion**
- Excludes a record that cannot be processed and continues with the remaining records.

**[Result Validation] Alternate Result Certification**
- Uses an independent consistency check when the primary completed-result check cannot run, without changing the candidate result.

#### Shutdown

**[Input Handling] Unreadable Input Rejection**
- Stops before processing when a required input file cannot be read.

**[Core Processing] Processing Failure Termination**
- Stops when processing fails before a complete result can be produced.

**[Result Validation] Invalid Result Rejection**
- Stops the operation without saving when the reported count does not match the result.

### Serving

#### Feature

**[Input Handling] Request Parameter Conversion**
- Converts request parameters into the input format accepted by the Core.

**[Input Handling] Result Presentation**
- Formats and truncates a completed Core result for display without changing the Core result.

**[Result Validation] Response Consistency Check**
- Checks a completed response against the Core result before returning it.

#### Fallback

**[Input Handling] Alternate Request Reading**
- Reads the same request values from query parameters when the request body cannot be read.

**[Input Handling] Partial Preview Display**
- Displays the available preview items when some items cannot be loaded.

**[Result Validation] Alternate Response Certification**
- Uses an independent check when the primary completed-response check cannot run, without changing response values.

#### Shutdown

**[Input Handling] Invalid Request Rejection**
- Rejects a request when required parameters are missing.

**[Input Handling] Execution Request Failure**
- Ends the request when the Core operation cannot be started.

**[Result Validation] Invalid Response Rejection**
- Does not return a result when the response cannot be matched to the requested operation.
```
