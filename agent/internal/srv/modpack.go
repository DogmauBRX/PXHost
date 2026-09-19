package srv

import (
	"archive/zip"
	"context"
	"crypto/sha1"
	"crypto/sha512"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/gxhost/agent/internal/fsx"
)

const (
	maxMrpackBytes      = int64(2 << 30)
	maxPackEntries      = 100000
	maxIndexBytes       = int64(4 << 20)
	maxExpandedBytes    = int64(10 << 30)
	maxCompressionRatio = uint64(1000)
)

type ModpackInstallSpec struct {
	SourceURL    string
	ExpectedSize int64
	SHA1         string
	SHA512       string
	DiskLimitMB  int64
}

type mrpackIndex struct {
	FormatVersion int `json:"formatVersion"`
	Files         []struct {
		Path      string            `json:"path"`
		Hashes    map[string]string `json:"hashes"`
		Downloads []string          `json:"downloads"`
		FileSize  int64             `json:"fileSize"`
		Env       map[string]string `json:"env"`
	} `json:"files"`
}

// InstallModpack builds the new tree beside the live directory and swaps it
// atomically only after every archive entry and referenced file is verified.
func (s *Server) InstallModpack(ctx context.Context, spec ModpackInstallSpec, progress func(int, string)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.State != StateOffline {
		return fmt.Errorf("%w (current state: %s)", ErrServerNotStopped, s.State)
	}
	if err := allowedModrinthURL(spec.SourceURL); err != nil {
		return err
	}
	if spec.ExpectedSize <= 0 || spec.ExpectedSize > maxMrpackBytes {
		return fmt.Errorf("modpack: invalid package size")
	}

	dataDir := filepath.Join(s.node.DataDir, s.UUID)
	stageDir := dataDir + ".modpack-staging"
	oldDir := dataDir + ".modpack-old"
	archivePath := dataDir + ".modpack-download"
	_ = os.RemoveAll(stageDir)
	_ = os.RemoveAll(oldDir)
	_ = os.Remove(archivePath)
	defer os.Remove(archivePath)

	if err := downloadVerified(ctx, spec.SourceURL, archivePath, spec.ExpectedSize, spec.SHA1, spec.SHA512); err != nil {
		return err
	}
	progress(25, "Pacote validado; preparando staging")
	if err := copyTree(dataDir, stageDir, s.spec.UID); err != nil {
		return fmt.Errorf("modpack: preparing staging: %w", err)
	}
	stageJail, err := fsx.Open(stageDir)
	if err != nil {
		return err
	}
	defer stageJail.Close()

	zr, err := zip.OpenReader(archivePath)
	if err != nil {
		return fmt.Errorf("modpack: invalid mrpack: %w", err)
	}
	defer zr.Close()
	if len(zr.File) > maxPackEntries {
		return fmt.Errorf("modpack: archive has too many entries")
	}
	var expanded int64
	for _, file := range zr.File {
		if file.UncompressedSize64 > uint64(maxExpandedBytes) || expanded > maxExpandedBytes-int64(file.UncompressedSize64) {
			return fmt.Errorf("modpack: archive expands beyond the safety limit")
		}
		expanded += int64(file.UncompressedSize64)
		if file.UncompressedSize64 > 1<<20 && file.CompressedSize64 > 0 && file.UncompressedSize64/file.CompressedSize64 > maxCompressionRatio {
			return fmt.Errorf("modpack: archive entry %q exceeds the compression-ratio limit", file.Name)
		}
	}
	index, err := readMrpackIndex(zr.File)
	if err != nil {
		return err
	}
	var incoming int64
	for _, f := range index.Files {
		if f.FileSize <= 0 || f.FileSize > maxExpandedBytes || incoming > maxExpandedBytes-f.FileSize {
			return fmt.Errorf("modpack: invalid or excessive declared file size for %q", f.Path)
		}
		incoming += f.FileSize
	}
	for _, f := range zr.File {
		if strings.HasPrefix(f.Name, "overrides/") || strings.HasPrefix(f.Name, "server-overrides/") {
			incoming += int64(f.UncompressedSize64)
		}
	}
	if err := stageJail.CheckQuota(incoming, spec.DiskLimitMB); err != nil {
		return err
	}

	for i, f := range index.Files {
		if f.Env["server"] == "unsupported" {
			continue
		}
		if err := safeRelative(f.Path); err != nil {
			return fmt.Errorf("modpack: invalid file path %q: %w", f.Path, err)
		}
		if len(f.Downloads) == 0 {
			return fmt.Errorf("modpack: file %q has no download", f.Path)
		}
		if err := allowedModrinthURL(f.Downloads[0]); err != nil {
			return fmt.Errorf("modpack: file %q: %w", f.Path, err)
		}
		dest := filepath.Join(stageDir, filepath.FromSlash(f.Path))
		if err := os.MkdirAll(filepath.Dir(dest), 0750); err != nil {
			return err
		}
		if err := downloadVerified(ctx, f.Downloads[0], dest, f.FileSize, f.Hashes["sha1"], f.Hashes["sha512"]); err != nil {
			return fmt.Errorf("modpack: file %q: %w", f.Path, err)
		}
		_ = os.Chown(dest, s.spec.UID, s.spec.UID)
		progress(30+(i+1)*50/max(1, len(index.Files)), fmt.Sprintf("Baixando arquivos do modpack (%d/%d)", i+1, len(index.Files)))
	}
	if err := extractOverrides(zr.File, stageDir, s.spec.UID); err != nil {
		return err
	}
	progress(85, "Validando e ativando os novos arquivos")

	if err := s.Jail.Close(); err != nil {
		return err
	}
	if err := os.Rename(dataDir, oldDir); err != nil {
		s.Jail, _ = fsx.Open(dataDir)
		return err
	}
	if err := os.Rename(stageDir, dataDir); err != nil {
		_ = os.Rename(oldDir, dataDir)
		s.Jail, _ = fsx.Open(dataDir)
		return err
	}
	newJail, err := fsx.Open(dataDir)
	if err != nil {
		return err
	}
	s.Jail = newJail
	go func() { time.Sleep(time.Hour); _ = os.RemoveAll(oldDir) }()
	progress(98, "Arquivos ativados")
	return nil
}

func allowedModrinthURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Hostname() != "cdn.modrinth.com" || u.User != nil {
		return fmt.Errorf("download URL is not an allowed Modrinth CDN URL")
	}
	return nil
}

func downloadVerified(ctx context.Context, source, dest string, expected int64, sha1Hex, sha512Hex string) error {
	if expected <= 0 {
		return fmt.Errorf("missing expected download size")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 15 * time.Minute, CheckRedirect: func(req *http.Request, via []*http.Request) error { return allowedModrinthURL(req.URL.String()) }}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download returned HTTP %d", resp.StatusCode)
	}
	// Modrinth's index fileSize is useful for quota planning but a small
	// number of CDN objects have stale size metadata (observed in production
	// with a two-byte difference). The cryptographic checksum is the actual
	// integrity authority. Keep a tight overrun cap to prevent an incorrect
	// index or response from turning into an unbounded download, then accept
	// a size discrepancy only when the full checksum still matches.
	maxDownload := expected + downloadSizeTolerance(expected)
	if resp.ContentLength > maxDownload {
		return fmt.Errorf("content-length exceeds safety limit: got %d, maximum %d", resp.ContentLength, maxDownload)
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0750); err != nil {
		return err
	}
	tmp := dest + ".part"
	defer os.Remove(tmp)
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0640)
	if err != nil {
		return err
	}
	var h hash.Hash
	expectedHash := ""
	if sha512Hex != "" {
		h, expectedHash = sha512.New(), strings.ToLower(sha512Hex)
	} else if sha1Hex != "" {
		h, expectedHash = sha1.New(), strings.ToLower(sha1Hex)
	} else {
		out.Close()
		return fmt.Errorf("download has no supported checksum")
	}
	n, copyErr := io.Copy(io.MultiWriter(out, h), io.LimitReader(resp.Body, maxDownload+1))
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if n > maxDownload {
		return fmt.Errorf("download exceeds safety limit: got more than %d bytes", maxDownload)
	}
	if hex.EncodeToString(h.Sum(nil)) != expectedHash {
		return fmt.Errorf("checksum verification failed")
	}
	return os.Rename(tmp, dest)
}

func downloadSizeTolerance(expected int64) int64 {
	const oneMiB = int64(1 << 20)
	tolerance := expected / 100 // at most a 1% metadata discrepancy
	if tolerance < oneMiB {
		return oneMiB
	}
	return tolerance
}

func readMrpackIndex(files []*zip.File) (*mrpackIndex, error) {
	for _, f := range files {
		if f.Name != "modrinth.index.json" {
			continue
		}
		if f.UncompressedSize64 > uint64(maxIndexBytes) {
			return nil, fmt.Errorf("modpack: index is too large")
		}
		r, err := f.Open()
		if err != nil {
			return nil, err
		}
		defer r.Close()
		var idx mrpackIndex
		if err := json.NewDecoder(io.LimitReader(r, maxIndexBytes)).Decode(&idx); err != nil {
			return nil, fmt.Errorf("modpack: invalid index: %w", err)
		}
		if idx.FormatVersion != 1 {
			return nil, fmt.Errorf("modpack: unsupported format version %d", idx.FormatVersion)
		}
		return &idx, nil
	}
	return nil, fmt.Errorf("modpack: modrinth.index.json is missing")
}

func extractOverrides(files []*zip.File, root string, uid int) error {
	for _, f := range files {
		prefix := ""
		if strings.HasPrefix(f.Name, "server-overrides/") {
			prefix = "server-overrides/"
		} else if strings.HasPrefix(f.Name, "overrides/") {
			prefix = "overrides/"
		} else {
			continue
		}
		rel := strings.TrimPrefix(f.Name, prefix)
		if rel == "" {
			continue
		}
		if err := safeRelative(rel); err != nil {
			return err
		}
		if f.Mode()&(os.ModeSymlink|os.ModeDevice|os.ModeNamedPipe|os.ModeSocket) != 0 {
			return fmt.Errorf("modpack: unsafe archive entry %q", f.Name)
		}
		dest := filepath.Join(root, filepath.FromSlash(rel))
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(dest, 0750); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(dest), 0750); err != nil {
			return err
		}
		r, err := f.Open()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0640)
		if err != nil {
			r.Close()
			return err
		}
		written, copyErr := io.Copy(out, io.LimitReader(r, int64(f.UncompressedSize64)+1))
		closeErr := out.Close()
		_ = r.Close()
		if copyErr != nil {
			return copyErr
		}
		if written != int64(f.UncompressedSize64) {
			return fmt.Errorf("modpack: archive entry %q size mismatch", f.Name)
		}
		if closeErr != nil {
			return closeErr
		}
		_ = os.Chown(dest, uid, uid)
	}
	return nil
}

func safeRelative(value string) error {
	if value == "" || strings.Contains(value, "\\") {
		return fmt.Errorf("path escapes staging directory")
	}
	cleanSlash := path.Clean(value)
	clean := filepath.FromSlash(cleanSlash)
	if path.IsAbs(cleanSlash) || filepath.IsAbs(clean) || cleanSlash == "." || cleanSlash == ".." || strings.HasPrefix(cleanSlash, "../") {
		return fmt.Errorf("path escapes staging directory")
	}
	return nil
}

func copyTree(source, dest string, uid int) error {
	return filepath.Walk(source, func(current string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(source, current)
		if err != nil {
			return err
		}
		if rel == "." {
			if err := os.MkdirAll(dest, info.Mode().Perm()); err != nil {
				return err
			}
			return chownStagedPath(dest, uid)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("symlink %q is not allowed", rel)
		}
		target := filepath.Join(dest, rel)
		if info.IsDir() {
			if err := os.MkdirAll(target, info.Mode().Perm()); err != nil {
				return err
			}
			return chownStagedPath(target, uid)
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("special file %q is not allowed", rel)
		}
		in, err := os.Open(current)
		if err != nil {
			return err
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode().Perm())
		if err != nil {
			_ = in.Close()
			return err
		}
		_, copyErr := io.Copy(out, in)
		inErr := in.Close()
		closeErr := out.Close()
		if copyErr != nil {
			return copyErr
		}
		if inErr != nil {
			return inErr
		}
		if closeErr != nil {
			return closeErr
		}
		return chownStagedPath(target, uid)
	})
}

func chownStagedPath(target string, uid int) error {
	if err := os.Chown(target, uid, uid); err != nil && runtime.GOOS == "linux" {
		return fmt.Errorf("chown staged path %q to uid %d: %w", target, uid, err)
	}
	return nil
}
