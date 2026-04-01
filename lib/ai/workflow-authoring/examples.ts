import "server-only";

import type { WorkflowAuthoringExample } from "./types";

export const WORKFLOW_AUTHORING_EXAMPLES: WorkflowAuthoringExample[] = [
	{
		name: "Minimal Linear Issue Triage",
		intent:
			"A simple linear workflow that initializes context, plans, and emits a result without review loops.",
		workflow: `document:
  dsl: "1.0.0"
  namespace: "dapr-swe"
  name: "minimal-issue-triage"
  version: "1.0.0"
  title: "Minimal Issue Triage"
  summary: "Simple linear issue triage workflow"
do:
  - initialize:
      set:
        issueNumber: \${ .input.issue_number }
        issueSummary: \${ .input.issue_summary }
  - plan:
      call: daprSwePlan
      with:
        issueNumber: \${ .issueNumber }
        issueSummary: \${ .issueSummary }
      output:
        as: plan
  - emitResult:
      emit:
        event:
          with:
            type: com.workflow.issue.triaged
            source: workflow-builder
            data:
              issueNumber: \${ .issueNumber }
              planSummary: \${ .plan.summary }`,
	},
	{
		name: "Review Loop",
		intent:
			"A valid shallow review loop using a for task with sibling do steps.",
		workflow: `document:
  dsl: "1.0.0"
  namespace: "dapr-swe"
  name: "review-loop"
  version: "1.0.0"
  title: "Review Loop"
  summary: "Run implementation and review for up to three cycles"
do:
  - initialize:
      call: daprSweInitialize
      with:
        repo: \${ .input.repo }
        issueNumber: \${ .input.issue_number }
      output:
        as: sandbox
  - plan:
      call: daprSwePlan
      with:
        sessionId: \${ .sandbox.sessionId }
        issueNumber: \${ .input.issue_number }
      output:
        as: plan
  - reviewLoop:
      for:
        each: attempt
        in: \${ [1, 2, 3] }
      do:
        - implement:
            call: daprSweDevelop
            with:
              sessionId: \${ .sandbox.sessionId }
              planId: \${ .plan.planId }
              stepIndex: 0
            output:
              as: developResult
        - review:
            call: daprSweReview
            with:
              sessionId: \${ .sandbox.sessionId }
              planId: \${ .plan.planId }
            output:
              as: review
        - approved:
            switch:
              - done:
                  when: \${ .review.approved == true }
                  then: end
  - end:
      emit:
        event:
          with:
            type: com.workflow.review.completed
            source: workflow-builder`,
	},
	{
		name: "Dapr SWE Resolve Issue",
		intent:
			"A canonical issue-resolution workflow using the supported dapr-swe steps and PR creation.",
		workflow: `document:
  dsl: "1.0.0"
  namespace: "dapr-swe"
  name: "resolve-issue"
  version: "1.0.0"
  title: "Resolve Issue"
  summary: "Resolve a GitHub issue with dapr-swe agents"
do:
  - initialize:
      call: daprSweInitialize
      with:
        owner: \${ .input.owner }
        repo: \${ .input.repo }
        issue_number: \${ .input.issue_number }
      output:
        as: sandbox
  - createPlan:
      call: daprSwePlan
      with:
        sessionId: \${ .sandbox.sessionId }
        issueNumber: \${ .input.issue_number }
      output:
        as: plan
  - implement:
      call: daprSweDevelop
      with:
        sessionId: \${ .sandbox.sessionId }
        planId: \${ .plan.planId }
        stepIndex: 0
      output:
        as: implementation
  - review:
      call: daprSweReview
      with:
        sessionId: \${ .sandbox.sessionId }
        planId: \${ .plan.planId }
      output:
        as: review
  - openPullRequest:
      switch:
        - approved:
            when: \${ .review.approved == true }
            then: commitPR
  - commitPR:
      call: daprSweCommitPR
      with:
        sessionId: \${ .sandbox.sessionId }
        issueNumber: \${ .input.issue_number }
      output:
        as: pullRequest
  - emitCompletion:
      emit:
        event:
          with:
            type: com.workflow.issue.resolved
            source: workflow-builder
            data:
              issueNumber: \${ .input.issue_number }
              prUrl: \${ .pullRequest.pr_url }`,
	},
];
