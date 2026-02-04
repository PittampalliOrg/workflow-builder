/*
Custom Function Template (Go)

This is a template for creating custom functions that can be executed
as OCI containers by the function-runner service.

Input:
  - Received via INPUT environment variable (JSON string)
  - Additional context available via EXECUTION_ID, WORKFLOW_ID, NODE_ID, NODE_NAME
  - Credentials injected as environment variables (e.g., API_KEY)

Output:
  - Write JSON to stdout (the function-runner captures this)
  - Use stderr for logs (not captured as output)

Example:

	INPUT='{"name":"World"}' go run main.go
	=> {"success":true,"result":"Hello, World!"}
*/
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// ============================================================================
// CUSTOMIZE THESE TYPES FOR YOUR FUNCTION
// ============================================================================

// Input represents the function input schema
type Input struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

// Output represents the function output schema
type Output struct {
	Success bool   `json:"success"`
	Result  string `json:"result,omitempty"`
	Error   string `json:"error,omitempty"`
}

// SetDefaults sets default values for optional fields
func (i *Input) SetDefaults() {
	if i.Name == "" {
		i.Name = "World"
	}
	if i.Count <= 0 {
		i.Count = 1
	}
}

// ============================================================================
// MAIN FUNCTION LOGIC
// ============================================================================

// Execute contains your main function logic
func Execute(input Input) Output {
	// Your custom logic here
	var messages []string
	for i := 0; i < input.Count; i++ {
		messages = append(messages, fmt.Sprintf("Hello, %s!", input.Name))
	}

	return Output{
		Success: true,
		Result:  strings.Join(messages, "\n"),
	}
}

// ============================================================================
// RUNNER (DO NOT MODIFY BELOW)
// ============================================================================

func main() {
	// Get input from environment variable
	inputJSON := os.Getenv("INPUT")
	if inputJSON == "" {
		inputJSON = "{}"
	}

	// Log context for debugging (goes to stderr, not captured as output)
	fmt.Fprintf(os.Stderr, "[Function] Execution ID: %s\n", getEnvOrDefault("EXECUTION_ID", "unknown"))
	fmt.Fprintf(os.Stderr, "[Function] Workflow ID: %s\n", getEnvOrDefault("WORKFLOW_ID", "unknown"))
	fmt.Fprintf(os.Stderr, "[Function] Node ID: %s\n", getEnvOrDefault("NODE_ID", "unknown"))

	// Parse input
	var input Input
	if err := json.Unmarshal([]byte(inputJSON), &input); err != nil {
		output := Output{
			Success: false,
			Error:   fmt.Sprintf("failed to parse input: %v", err),
		}
		writeOutput(output)
		os.Exit(1)
	}

	// Set defaults
	input.SetDefaults()

	fmt.Fprintf(os.Stderr, "[Function] Input: %+v\n", input)

	// Execute the function
	output := Execute(input)

	// Write output to stdout
	writeOutput(output)

	// Exit with appropriate code
	if output.Success {
		os.Exit(0)
	} else {
		os.Exit(1)
	}
}

func writeOutput(output Output) {
	data, err := json.Marshal(output)
	if err != nil {
		fmt.Printf(`{"success":false,"error":"failed to marshal output: %v"}`, err)
		return
	}
	fmt.Println(string(data))
}

func getEnvOrDefault(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}
