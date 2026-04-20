// Copyright 2025 The Kubernetes Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"

	"k8s.io/klog/v2"
)

func main() {
	ctx := context.Background()
	if err := run(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

func run(ctx context.Context) error {
	log := klog.FromContext(ctx)

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	vnc := &VNCServer{}

	errs := make(chan error, 10)

	go func() {
		if err := vnc.Run(ctx); err != nil {
			log.Error(err, "VNC server exited with error")
			errs <- fmt.Errorf("VNC server exited with error: %w", err)
			cancel()
		}
	}()

	if err := vnc.WaitForReady(ctx); err != nil {
		return fmt.Errorf("failed to wait for VNC server: %w", err)
	}

	chrome := &Chrome{}
	go func() {
		if err := chrome.Run(ctx); err != nil {
			log.Error(err, "Chrome exited with error")
			errs <- fmt.Errorf("Chrome exited with error: %w", err)
			cancel()
		}
	}()

	if err := chrome.WaitForReady(ctx); err != nil {
		return fmt.Errorf("failed to wait for Chrome: %w", err)
	}
	log.Info("Chrome and VNC server are running")

	<-ctx.Done()
	errs <- ctx.Err()

	// Return the first error (or nil))
	return <-errs
}

type Chrome struct {
}

func (c *Chrome) Run(ctx context.Context) error {
	cmd := exec.CommandContext(ctx, "/start-chrome")
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	var env []string
	for _, e := range os.Environ() {
		if strings.HasPrefix(e, "DISPLAY=") {
			continue
		}
		env = append(env, e)
	}
	env = append(env, "DISPLAY=:1")
	cmd.Env = env

	return cmd.Run()
}

func (c *Chrome) WaitForReady(ctx context.Context) error {
	log := klog.FromContext(ctx)

	u := "http://localhost:9222/json/version"

	httpClient := &http.Client{}
	httpClient.Timeout = 200 * time.Millisecond

	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}

		req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
		if err != nil {
			return fmt.Errorf("failed to create HTTP request: %w", err)
		}

		ready := func() bool {
			// Send the HTTP request
			response, err := httpClient.Do(req)
			if err != nil {
				log.Info("Waiting for Chrome to be ready", "url", u, "error", err)
				return false
			}
			defer response.Body.Close()

			// Check for HTTP 200 OK
			if response.StatusCode != http.StatusOK {
				log.Info("Waiting for Chrome to be ready", "url", u, "status", response.Status)
				return false
			}

			b, err := io.ReadAll(response.Body)
			if err != nil {
				log.Info("Waiting for Chrome to be ready", "url", u, "error", err)
				return false
			}

			log.Info("Chrome is ready", "url", u, "response", string(b))
			return true
		}()

		if ready {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
}

type VNCServer struct {
}

func (v *VNCServer) Run(ctx context.Context) error {
	log := klog.FromContext(ctx)

	// Xvfb + x11vnc instead of Xtigervnc. TigerVNC's SConnection rejects
	// SetPixelFormat(bgr888) as "invalid pixel format" — noVNC in the
	// browser always requests bgr888 because canvas is little-endian BGRA,
	// so every browser client was closed mid-handshake. x11vnc accepts any
	// valid pixel format the client asks for and transcodes server-side.
	//
	// The two processes share display :1: Xvfb hosts a virtual framebuffer
	// there; x11vnc exports it to TCP :5901.
	//
	// x11vnc flags:
	//   -nopw          no auth (BFF WS proxy gates the connection)
	//   -forever       keep serving after the last client disconnects
	//   -shared        allow multiple concurrent clients
	//   -rfbport 5901  pin the port
	//   -wait 40       40ms between framebuffer polls (~25 fps). Without
	//                  this x11vnc pegs 100% CPU, starves its own accept
	//                  loop, and never completes the RFB handshake.
	//   -defer 40      batch screen-update coalescence window.
	//   -nocursor      don't render a cursor sprite (Chromium has its own).
	//   -quiet         suppress per-client handshake chatter.
	cmd := exec.CommandContext(ctx, "bash", "-c",
		"set -e; "+
			"Xvfb :1 -screen 0 1280x1024x24 -ac +extension RANDR -nolisten tcp & "+
			"XVFB_PID=$!; "+
			"for i in $(seq 1 50); do xdpyinfo -display :1 >/dev/null 2>&1 && break; sleep 0.1; done; "+
			"exec x11vnc -display :1 -nopw -forever -shared -rfbport 5901 -wait 40 -defer 40 -nocursor -quiet",
	)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	log.Info("Starting VNC server", "command", cmd.String())
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("failed to start VNC server: %w", err)
	}

	go func() {
		<-ctx.Done()
		if err := cmd.Process.Kill(); err != nil {
			log.Error(err, "failed to kill VNC server")
		}
	}()

	if err := cmd.Wait(); err != nil {
		return fmt.Errorf("VNC server exited with error: %w", err)
	}

	return nil
}

func (v *VNCServer) WaitForReady(ctx context.Context) error {
	log := klog.FromContext(ctx)

	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}

		cmd := exec.CommandContext(ctx, "xdpyinfo", "-display", ":1")
		var stdout bytes.Buffer
		cmd.Stdout = &stdout
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		if err := cmd.Run(); err != nil {
			log.Info("Waiting for VNC server to be ready", "error", err)
			time.Sleep(100 * time.Millisecond)
			continue
		}

		log.Info("VNC is ready")
		break
	}
	return nil

}
