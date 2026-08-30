// Command wsclient is a throwaway dev tool that exercises the agent's
// console/stats WebSocket end-to-end, standing in for a browser (or
// websocat, when unavailable) to validate the M2 console demo: connect,
// authenticate, send a command, observe it echoed back through the
// console output stream, and see live stats frames.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

type envelope struct {
	Event string          `json:"event"`
	Seq   uint64          `json:"seq,omitempty"`
	Data  json.RawMessage `json:"data,omitempty"`
	TS    int64           `json:"ts,omitempty"`
}

func main() {
	url := flag.String("url", "", "ws:// URL, e.g. ws://127.0.0.1:8443/api/servers/<uuid>/ws")
	token := flag.String("token", "", "capability token")
	command := flag.String("command", "", "console command to send after auth (optional)")
	power := flag.String("power", "", "power action to send after auth: start|stop|restart|kill (optional)")
	duration := flag.Duration("duration", 4*time.Second, "how long to listen for frames")
	flag.Parse()

	if *url == "" || *token == "" {
		fmt.Fprintln(os.Stderr, "usage: wsclient --url ws://... --token <jwt> [--command 'text'] [--duration 4s]")
		os.Exit(2)
	}

	ctx, cancel := context.WithTimeout(context.Background(), *duration+5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, *url, nil)
	must(err)
	defer conn.CloseNow()

	must(writeJSON(ctx, conn, envelope{Event: "auth", Data: mustJSON(map[string]string{"token": *token})}))

	var authOK envelope
	must(readJSON(ctx, conn, &authOK))
	fmt.Printf("<- %s %s\n", authOK.Event, string(authOK.Data))
	if authOK.Event != "auth:ok" {
		fmt.Println("authentication failed, aborting")
		os.Exit(1)
	}

	if *command != "" {
		time.Sleep(300 * time.Millisecond) // let scrollback replay drain first
		fmt.Printf("-> console:send %q\n", *command)
		must(writeJSON(ctx, conn, envelope{Event: "console:send", Data: mustJSON(map[string]string{"command": *command})}))
	}
	if *power != "" {
		time.Sleep(300 * time.Millisecond)
		fmt.Printf("-> power:set %q\n", *power)
		must(writeJSON(ctx, conn, envelope{Event: "power:set", Data: mustJSON(map[string]string{"action": *power})}))
	}

	deadline := time.Now().Add(*duration)
	for time.Now().Before(deadline) {
		readCtx, cancel := context.WithDeadline(ctx, deadline)
		var env envelope
		err := readJSON(readCtx, conn, &env)
		cancel()
		if err != nil {
			fmt.Println("read error:", err)
			break
		}
		fmt.Printf("<- %s %s\n", env.Event, truncate(string(env.Data), 200))
	}

	conn.Close(websocket.StatusNormalClosure, "done")
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

// Delegates to wsjson rather than hand-rolling json.NewDecoder over
// c.Reader(): that version reads intermittently failed with "previous
// message not read to completion", because json.Decoder stops as soon as
// it has one complete value without necessarily draining the underlying
// message reader to EOF, which coder/websocket requires between messages.
func writeJSON(ctx context.Context, c *websocket.Conn, v any) error {
	return wsjson.Write(ctx, c, v)
}

func readJSON(ctx context.Context, c *websocket.Conn, v any) error {
	return wsjson.Read(ctx, c, v)
}

func mustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	must(err)
	return b
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "wsclient: "+err.Error())
		os.Exit(1)
	}
}
