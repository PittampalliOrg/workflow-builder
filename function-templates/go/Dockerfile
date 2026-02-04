# Function Template: Go
# This Dockerfile builds a custom Go function for OCI execution.
#
# The function receives input via the INPUT environment variable (JSON)
# and should write output to stdout (JSON or text).
#
# Build:
#   docker build -t my-function:v1 .
#
# Test locally:
#   docker run -e INPUT='{"name":"World"}' my-function:v1

# Build stage
FROM golang:1.23-alpine AS builder

WORKDIR /app

# Copy go mod files
COPY go.mod go.sum ./

# Download dependencies
RUN go mod download

# Copy source
COPY . .

# Build static binary
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o function .

# Production stage (minimal image)
FROM scratch

# Copy the binary
COPY --from=builder /app/function /function

# Copy SSL certificates for HTTPS requests
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/

# Non-root user (UID 1001)
USER 1001

# The function reads INPUT env var and writes to stdout
ENTRYPOINT ["/function"]
