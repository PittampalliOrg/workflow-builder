/**
 * Planner Agent Event Viewer
 * Real-time workflow event streaming via WebSocket
 */

class PlannerAgent {
  constructor() {
    this.ws = null;
    this.workflowId = null;
    this.events = [];
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;

    this.elements = {
      statusDot: document.getElementById("status-dot"),
      statusText: document.getElementById("status-text"),
      taskInput: document.getElementById("task-input"),
      submitBtn: document.getElementById("submit-btn"),
      workflowId: document.getElementById("workflow-id"),
      workflowStatus: document.getElementById("workflow-status"),
      workflowPhase: document.getElementById("workflow-phase"),
      workflowProgress: document.getElementById("workflow-progress"),
      progressFill: document.getElementById("progress-fill"),
      eventsCount: document.getElementById("events-count"),
      eventsList: document.getElementById("events-list"),
      approvalButtons: document.getElementById("approval-buttons"),
      approveBtn: document.getElementById("approve-btn"),
      rejectBtn: document.getElementById("reject-btn"),
    };

    this.init();
  }

  init() {
    // Event listeners
    this.elements.submitBtn.addEventListener("click", () => this.submitTask());
    this.elements.taskInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.metaKey) {
        this.submitTask();
      }
    });
    this.elements.approveBtn.addEventListener("click", () =>
      this.approveWorkflow(true)
    );
    this.elements.rejectBtn.addEventListener("click", () =>
      this.approveWorkflow(false)
    );

    // Check for workflow ID in URL
    const urlParams = new URLSearchParams(window.location.search);
    const workflowId = urlParams.get("workflow");
    if (workflowId) {
      this.connectToWorkflow(workflowId);
    }

    this.updateConnectionStatus(false);
  }

  updateConnectionStatus(connected) {
    this.elements.statusDot.classList.toggle("connected", connected);
    this.elements.statusText.textContent = connected
      ? "Connected"
      : "Disconnected";
  }

  async submitTask() {
    const task = this.elements.taskInput.value.trim();
    if (!task) {
      return;
    }

    this.elements.submitBtn.disabled = true;
    this.elements.submitBtn.textContent = "Starting...";

    try {
      const response = await fetch("/workflow/dapr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task,
          auto_approve: false,
          model: "gpt-4o-mini",
          max_turns: 20,
        }),
      });

      const data = await response.json();

      if (data.workflow_id) {
        this.workflowId = data.workflow_id;
        this.events = [];
        this.elements.eventsList.innerHTML = "";

        // Update URL
        const url = new URL(window.location);
        url.searchParams.set("workflow", this.workflowId);
        window.history.pushState({}, "", url);

        this.connectToWorkflow(this.workflowId);
        this.updateWorkflowInfo({
          id: this.workflowId,
          status: "running",
          phase: "starting",
          progress: 0,
        });
      } else {
        this.addEvent({
          type: "error",
          message: data.error || "Failed to start workflow",
          timestamp: new Date().toISOString(),
        });
      }
    } catch (error) {
      this.addEvent({
        type: "error",
        message: `Error: ${error.message}`,
        timestamp: new Date().toISOString(),
      });
    } finally {
      this.elements.submitBtn.disabled = false;
      this.elements.submitBtn.textContent = "Start Workflow";
    }
  }

  connectToWorkflow(workflowId) {
    this.workflowId = workflowId;

    // Close existing connection
    if (this.ws) {
      this.ws.close();
    }

    // Connect to WebSocket endpoint
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws/workflows/${workflowId}`;

    console.log("Connecting to WebSocket:", wsUrl);

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log("WebSocket connected");
      this.updateConnectionStatus(true);
      this.reconnectAttempts = 0;
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.handleEvent(data);
      } catch (e) {
        console.error("Failed to parse event:", e);
      }
    };

    this.ws.onclose = (event) => {
      console.log("WebSocket closed:", event.code, event.reason);
      this.updateConnectionStatus(false);

      // Attempt to reconnect
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        console.log(`Reconnecting (attempt ${this.reconnectAttempts})...`);
        setTimeout(() => this.connectToWorkflow(workflowId), 2000);
      }
    };

    this.ws.onerror = (error) => {
      console.error("WebSocket error:", error);
    };

    // Also fetch current workflow state
    this.fetchWorkflowState(workflowId);
  }

  async fetchWorkflowState(workflowId) {
    try {
      const response = await fetch(`/workflows/${workflowId}`);
      const data = await response.json();

      this.updateWorkflowInfo({
        id: workflowId,
        status: data.status || data.phase,
        phase: data.phase,
        progress: data.progress || 0,
      });

      // Show approval buttons if awaiting approval
      if (
        data.phase === "awaiting_approval" ||
        data.status === "AWAITING_APPROVAL"
      ) {
        this.showApprovalButtons();
      }
    } catch (error) {
      console.error("Failed to fetch workflow state:", error);
    }
  }

  handleEvent(data) {
    // Update workflow info from event
    if (data.phase || data.progress !== undefined) {
      this.updateWorkflowInfo({
        id: this.workflowId,
        status: data.status || data.phase,
        phase: data.phase,
        progress: data.progress,
      });
    }

    // Show approval buttons if needed
    if (
      data.phase === "awaiting_approval" ||
      data.type === "approval_required"
    ) {
      this.showApprovalButtons();
    }

    // Hide approval buttons if workflow progressed past approval
    if (
      data.phase === "execution" ||
      data.phase === "testing" ||
      data.phase === "completed"
    ) {
      this.hideApprovalButtons();
    }

    // Add event to list
    this.addEvent(data);
  }

  addEvent(event) {
    this.events.push(event);
    this.elements.eventsCount.textContent = this.events.length;

    const eventEl = document.createElement("div");
    eventEl.className = `event-item ${event.type || event.phase || ""}`;

    const timestamp = event.timestamp
      ? new Date(event.timestamp).toLocaleTimeString()
      : new Date().toLocaleTimeString();
    const eventType = event.type || event.phase || "info";
    const message =
      event.message || event.data?.message || this.formatEventMessage(event);

    eventEl.innerHTML = `
            <div class="event-header">
                <span class="event-type ${eventType}">${eventType.replace(/_/g, " ")}</span>
                <span class="event-time">${timestamp}</span>
            </div>
            <div class="event-message">${this.escapeHtml(message)}</div>
            ${this.formatEventDetails(event)}
        `;

    this.elements.eventsList.appendChild(eventEl);

    // Auto-scroll to bottom
    this.elements.eventsList.scrollTop = this.elements.eventsList.scrollHeight;
  }

  formatEventMessage(event) {
    if (event.type === "tool_call") {
      return `Tool: ${event.tool_name || event.data?.tool_name || "unknown"}`;
    }
    if (event.type === "tool_result") {
      return `Result from: ${event.tool_name || event.data?.tool_name || "unknown"}`;
    }
    if (event.type === "phase_started") {
      return `Phase started: ${event.phase || event.data?.phase || "unknown"}`;
    }
    if (event.type === "phase_completed") {
      return `Phase completed: ${event.phase || event.data?.phase || "unknown"}`;
    }
    return JSON.stringify(event.data || event, null, 2);
  }

  formatEventDetails(event) {
    const data = event.data || event;

    // Tool call details
    if (event.type === "tool_call" && data.arguments) {
      return `<div class="event-details">${this.escapeHtml(JSON.stringify(data.arguments, null, 2))}</div>`;
    }

    // Tool result details
    if (event.type === "tool_result" && data.result) {
      const result =
        typeof data.result === "string"
          ? data.result
          : JSON.stringify(data.result, null, 2);
      return `<div class="event-details">${this.escapeHtml(result.substring(0, 500))}${result.length > 500 ? "..." : ""}</div>`;
    }

    // Plan details
    if (data.plan) {
      return `<div class="event-details">${this.escapeHtml(JSON.stringify(data.plan, null, 2))}</div>`;
    }

    return "";
  }

  updateWorkflowInfo(info) {
    this.elements.workflowId.textContent = info.id || "-";

    const status = (info.status || "unknown").toLowerCase();
    this.elements.workflowStatus.textContent = status;
    this.elements.workflowStatus.className = `status-badge ${this.getStatusClass(status)}`;

    this.elements.workflowPhase.textContent = info.phase || "-";

    const progress = info.progress || 0;
    this.elements.workflowProgress.textContent = `${progress}%`;
    this.elements.progressFill.style.width = `${progress}%`;
  }

  getStatusClass(status) {
    if (
      status.includes("running") ||
      status.includes("execution") ||
      status.includes("planning") ||
      status.includes("testing")
    ) {
      return "running";
    }
    if (status.includes("completed") || status.includes("passed")) {
      return "completed";
    }
    if (status.includes("failed") || status.includes("error")) {
      return "failed";
    }
    if (status.includes("awaiting") || status.includes("approval")) {
      return "awaiting";
    }
    return "";
  }

  showApprovalButtons() {
    this.elements.approvalButtons.style.display = "flex";
  }

  hideApprovalButtons() {
    this.elements.approvalButtons.style.display = "none";
  }

  async approveWorkflow(approved) {
    if (!this.workflowId) {
      return;
    }

    try {
      const response = await fetch(`/workflow/${this.workflowId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved }),
      });

      const _data = await response.json();

      this.addEvent({
        type: approved ? "approval" : "rejection",
        message: approved
          ? "Plan approved - continuing to execution"
          : "Plan rejected",
        timestamp: new Date().toISOString(),
      });

      this.hideApprovalButtons();
    } catch (error) {
      this.addEvent({
        type: "error",
        message: `Approval error: ${error.message}`,
        timestamp: new Date().toISOString(),
      });
    }
  }

  escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }
}

// Initialize on page load
document.addEventListener("DOMContentLoaded", () => {
  window.plannerAgent = new PlannerAgent();
});
