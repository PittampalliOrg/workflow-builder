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
      call: daprSweInitialize
      with:
        owner: \${ .input.owner }
        repo: \${ .input.repo }
        issue_number: \${ .input.issue_number }
        title: \${ .input.title }
        body: \${ .input.body }
      output:
        as: sandbox
  - plan:
      call: daprSwePlan
      with:
        sandbox_id: \${ .initialize.sandbox_id }
        working_dir: \${ .initialize.working_dir }
        agents_md: \${ .initialize.agents_md }
        github_token: \${ .initialize.github_token }
        owner: \${ .input.owner }
        repo: \${ .input.repo }
        issue_number: \${ .input.issue_number }
        title: \${ .input.title }
        body: \${ .input.body }
      output:
        as: plan
  - emitResult:
      emit:
        event:
          with:
            type: com.workflow.issue.triaged
            source: workflow-builder
            data:
              issueNumber: \${ .input.issue_number }
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
        owner: \${ .input.owner }
        repo: \${ .input.repo }
        issue_number: \${ .input.issue_number }
        title: \${ .input.title }
      output:
        as: sandbox
  - plan:
      call: daprSwePlan
      with:
        sandbox_id: \${ .initialize.sandbox_id }
        working_dir: \${ .initialize.working_dir }
        agents_md: \${ .initialize.agents_md }
        github_token: \${ .initialize.github_token }
        owner: \${ .input.owner }
        repo: \${ .input.repo }
        issue_number: \${ .input.issue_number }
        title: \${ .input.title }
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
              sandbox_id: \${ .initialize.sandbox_id }
              working_dir: \${ .initialize.working_dir }
              github_token: \${ .initialize.github_token }
              owner: \${ .input.owner }
              repo: \${ .input.repo }
              issue_number: \${ .input.issue_number }
              title: \${ .input.title }
              plan: \${ .plan.plan }
            output:
              as: developResult
        - review:
            call: daprSweReview
            with:
              sandbox_id: \${ .initialize.sandbox_id }
              working_dir: \${ .initialize.working_dir }
              owner: \${ .input.owner }
              repo: \${ .input.repo }
              issue_number: \${ .input.issue_number }
              title: \${ .input.title }
              plan: \${ .plan.plan }
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
        title: \${ .input.title }
        body: \${ .input.body }
      output:
        as: sandbox
  - createPlan:
      call: daprSwePlan
      with:
        sandbox_id: \${ .initialize.sandbox_id }
        working_dir: \${ .initialize.working_dir }
        agents_md: \${ .initialize.agents_md }
        github_token: \${ .initialize.github_token }
        owner: \${ .input.owner }
        repo: \${ .input.repo }
        issue_number: \${ .input.issue_number }
        title: \${ .input.title }
        body: \${ .input.body }
      output:
        as: plan
  - implementChanges:
      call: daprSweDevelop
      with:
        sandbox_id: \${ .initialize.sandbox_id }
        working_dir: \${ .initialize.working_dir }
        github_token: \${ .initialize.github_token }
        owner: \${ .input.owner }
        repo: \${ .input.repo }
        issue_number: \${ .input.issue_number }
        title: \${ .input.title }
        body: \${ .input.body }
        plan: \${ .createPlan.plan }
  - review:
      call: daprSweReview
      with:
        sandbox_id: \${ .initialize.sandbox_id }
        working_dir: \${ .initialize.working_dir }
        owner: \${ .input.owner }
        repo: \${ .input.repo }
        issue_number: \${ .input.issue_number }
        title: \${ .input.title }
        plan: \${ .createPlan.plan }
      output:
        as: review
  - reviewGate:
      switch:
        - approved:
            when: \${ .review.approved == true }
            then: commitPR
        - notApproved:
            when: \${ .review.approved != true }
            then: emitReviewRejected
  - commitPR:
      call: daprSweCommitPR
      with:
        sandbox_id: \${ .initialize.sandbox_id }
        working_dir: \${ .initialize.working_dir }
        github_token: \${ .initialize.github_token }
        owner: \${ .input.owner }
        repo: \${ .input.repo }
        issue_number: \${ .input.issue_number }
        title: \${ .input.title }
        plan: \${ .createPlan.plan }
        review: \${ .review }
      then: emitCompletion
      output:
        as: pullRequest
  - emitReviewRejected:
      emit:
        event:
          with:
            type: com.workflow.issue.review-rejected
            source: workflow-builder
            data:
              issueNumber: \${ .input.issue_number }
              feedback: \${ .review.feedback }
      then: end
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
