import { buildCodingWorkflow, type CodingWorkflowBackend, type WorkflowTemplate } from "./coding-workflow";

export type TemplateInfo = {
  id: string;
  name: string;
  description: string;
  category: string;
  nodeCount: number;
  tags: string[];
  build: () => WorkflowTemplate;
};

export const workflowTemplates: TemplateInfo[] = [
  {
    id: "async-coding-deepagent",
    name: "Async Coding (DeepAgent)",
    description:
      "7-node coding workflow: sandbox provisioning, agent plan/execute with approval, review, and browser validation. Uses the OpenShell DeepAgent backend.",
    category: "AI Coding",
    nodeCount: 7,
    tags: ["coding", "agent", "sandbox", "browser-validation"],
    build: () => buildCodingWorkflow({ backend: "openshell-deepagent" }),
  },
  {
    id: "async-coding-durable",
    name: "Async Coding (Durable Agent)",
    description:
      "7-node coding workflow: sandbox provisioning, durable agent plan/execute with Dapr workflow orchestration, review, and browser validation.",
    category: "AI Coding",
    nodeCount: 7,
    tags: ["coding", "agent", "durable", "sandbox", "browser-validation"],
    build: () => buildCodingWorkflow({ backend: "openshell-durable" }),
  },
];

export function getTemplate(id: string): TemplateInfo | undefined {
  return workflowTemplates.find((t) => t.id === id);
}

export { buildCodingWorkflow, type CodingWorkflowBackend, type WorkflowTemplate };
