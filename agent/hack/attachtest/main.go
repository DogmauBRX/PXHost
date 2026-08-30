// Command attachtest isolates exactly what internal/console.Pump does
// (ContainerAttach with Tty:false, write to stdin, read demuxed stdout)
// against a real container, with an explicit watchdog so a hang shows up
// as a clear timeout message instead of silence.
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/docker/docker/pkg/stdcopy"
	"github.com/pxhost/agent/internal/dockerx"
)

func main() {
	containerID := flag.String("container", "", "container id or name")
	flag.Parse()
	if *containerID == "" {
		fmt.Fprintln(os.Stderr, "usage: attachtest --container <id>")
		os.Exit(2)
	}

	ctx := context.Background()
	dc, err := dockerx.New(ctx)
	must(err)
	defer dc.Close()

	fmt.Println("attaching...")
	conn, err := dc.AttachIO(ctx, *containerID)
	must(err)
	fmt.Println("attached OK")

	outR, outW := io.Pipe()
	errR, errW := io.Pipe()
	go func() {
		defer outW.Close()
		defer errW.Close()
		_, cerr := stdcopy.StdCopy(outW, errW, conn.Reader)
		fmt.Println("stdcopy ended:", cerr)
	}()
	go drain(outR, "stdout")
	go drain(errR, "stderr")

	fmt.Println("writing to stdin...")
	writeDone := make(chan error, 1)
	go func() {
		_, err := conn.Conn.Write([]byte("attachtest-line\n"))
		writeDone <- err
	}()

	select {
	case err := <-writeDone:
		fmt.Println("write returned, err =", err)
	case <-time.After(3 * time.Second):
		fmt.Println("WRITE HUNG: no return after 3s")
	}

	time.Sleep(2 * time.Second)
	fmt.Println("done")
}

func drain(r io.Reader, label string) {
	buf := make([]byte, 4096)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			fmt.Printf("[%s] %q\n", label, string(buf[:n]))
		}
		if err != nil {
			fmt.Printf("[%s] read ended: %v\n", label, err)
			return
		}
	}
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "attachtest: "+err.Error())
		os.Exit(1)
	}
}
