package backup

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/pxhost/agent/internal/fsx"
)

// backupIDPattern is deliberately strict: a backup ID reaches this
// package from an HTTP path/query parameter, and it becomes a literal
// filename component below (never resolved through fsx, since the
// backup store is intentionally outside any jail) — this is the
// equivalent guard for that different trust boundary.
var backupIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,128}$`)

// LocalProvider stores backups as <root>/<serverUUID>/<id>.tar.gz plus a
// <id>.json sidecar (size/sha256/createdAt) so List never has to read an
// entire archive just to report its metadata.
type LocalProvider struct {
	root string
}

func NewLocalProvider(root string) *LocalProvider {
	return &LocalProvider{root: root}
}

func (p *LocalProvider) serverDir(serverUUID string) string {
	return filepath.Join(p.root, serverUUID)
}

func (p *LocalProvider) backupPath(serverUUID, backupID string) (string, error) {
	if !backupIDPattern.MatchString(backupID) {
		return "", fmt.Errorf("%w: invalid backup id %q", ErrNotFound, backupID)
	}
	return filepath.Join(p.serverDir(serverUUID), backupID+".tar.gz"), nil
}

type metaFile struct {
	SizeBytes int64     `json:"sizeBytes"`
	SHA256    string    `json:"sha256"`
	CreatedAt time.Time `json:"createdAt"`
}

// GenerateBackupID is exported so callers (srv.Server) can log/reference
// the id before Create returns, if needed later.
func GenerateBackupID() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return time.Now().UTC().Format("20060102T150405Z") + "-" + hex.EncodeToString(b)
}

// Create streams src's entire tree (skipping anything ignore matches)
// through tar -> gzip -> the destination file, tee'd into a running
// sha256 — constant memory regardless of server size (architecture doc
// 4.5), since nothing is ever buffered whole.
func (p *LocalProvider) Create(_ context.Context, serverUUID string, src *fsx.Jail, ignore *IgnoreSet) (Backup, error) {
	dir := p.serverDir(serverUUID)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return Backup{}, fmt.Errorf("backup: creating backup dir: %w", err)
	}
	id := GenerateBackupID()
	tarPath := filepath.Join(dir, id+".tar.gz")

	f, err := os.OpenFile(tarPath, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600)
	if err != nil {
		return Backup{}, fmt.Errorf("backup: creating archive: %w", err)
	}

	hasher := sha256.New()
	gz := gzip.NewWriter(io.MultiWriter(f, hasher))
	tw := tar.NewWriter(gz)

	if err := walkAndTar(tw, src, ".", ignore); err != nil {
		tw.Close()
		gz.Close()
		f.Close()
		_ = os.Remove(tarPath)
		return Backup{}, fmt.Errorf("backup: writing archive: %w", err)
	}
	if err := tw.Close(); err != nil {
		gz.Close()
		f.Close()
		_ = os.Remove(tarPath)
		return Backup{}, err
	}
	if err := gz.Close(); err != nil {
		f.Close()
		_ = os.Remove(tarPath)
		return Backup{}, err
	}
	stat, err := f.Stat()
	f.Close()
	if err != nil {
		return Backup{}, err
	}

	meta := metaFile{SizeBytes: stat.Size(), SHA256: hex.EncodeToString(hasher.Sum(nil)), CreatedAt: time.Now().UTC()}
	metaBytes, _ := json.Marshal(meta)
	if err := os.WriteFile(filepath.Join(dir, id+".json"), metaBytes, 0o600); err != nil {
		return Backup{}, fmt.Errorf("backup: writing metadata: %w", err)
	}

	return Backup{ID: id, SizeBytes: meta.SizeBytes, SHA256: meta.SHA256, CreatedAt: meta.CreatedAt}, nil
}

// walkAndTar recurses src via the SAME jail-resolved List/Open every
// other file operation uses — a backup can never read outside the
// server's own directory any more than the file manager can.
func walkAndTar(tw *tar.Writer, src *fsx.Jail, relDir string, ignore *IgnoreSet) error {
	entries, err := src.List(relDir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		rel := e.Name
		if relDir != "." {
			rel = relDir + "/" + e.Name
		}
		if ignore.Match(rel) {
			continue
		}
		if e.IsDir {
			if err := walkAndTar(tw, src, rel, ignore); err != nil {
				return err
			}
			continue
		}
		if err := tarOneFile(tw, src, rel, e.Size, e.ModTime); err != nil {
			return err
		}
	}
	return nil
}

func tarOneFile(tw *tar.Writer, src *fsx.Jail, rel string, size int64, modTime time.Time) error {
	f, err := src.Open(rel)
	if err != nil {
		return err
	}
	defer f.Close()

	hdr := &tar.Header{Name: rel, Size: size, Mode: 0o644, ModTime: modTime, Typeflag: tar.TypeReg}
	if err := tw.WriteHeader(hdr); err != nil {
		return err
	}
	_, err = io.Copy(tw, f)
	return err
}

// Put streams r into a new archive under id — see the Provider interface
// doc comment. Same shape as Create's tail half (write, hash, size,
// sidecar) with the walk-and-tar front half replaced by a plain copy,
// since the caller already has finished tar.gz bytes (fetched from
// another node), not a live directory tree to walk.
func (p *LocalProvider) Put(_ context.Context, serverUUID, id string, r io.Reader) (Backup, error) {
	if !backupIDPattern.MatchString(id) {
		return Backup{}, fmt.Errorf("%w: invalid id %q", ErrNotFound, id)
	}
	dir := p.serverDir(serverUUID)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return Backup{}, fmt.Errorf("backup: creating dir: %w", err)
	}
	tarPath := filepath.Join(dir, id+".tar.gz")

	f, err := os.OpenFile(tarPath, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600)
	if err != nil {
		return Backup{}, fmt.Errorf("backup: creating archive: %w", err)
	}
	hasher := sha256.New()
	size, err := io.Copy(io.MultiWriter(f, hasher), r)
	if err != nil {
		f.Close()
		_ = os.Remove(tarPath)
		return Backup{}, fmt.Errorf("backup: writing archive: %w", err)
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tarPath)
		return Backup{}, err
	}

	meta := metaFile{SizeBytes: size, SHA256: hex.EncodeToString(hasher.Sum(nil)), CreatedAt: time.Now().UTC()}
	metaBytes, _ := json.Marshal(meta)
	if err := os.WriteFile(filepath.Join(dir, id+".json"), metaBytes, 0o600); err != nil {
		return Backup{}, fmt.Errorf("backup: writing metadata: %w", err)
	}
	return Backup{ID: id, SizeBytes: meta.SizeBytes, SHA256: meta.SHA256, CreatedAt: meta.CreatedAt}, nil
}

func (p *LocalProvider) List(_ context.Context, serverUUID string) ([]Backup, error) {
	dir := p.serverDir(serverUUID)
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return []Backup{}, nil
		}
		return nil, err
	}
	out := make([]Backup, 0, len(entries))
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		id := strings.TrimSuffix(e.Name(), ".json")
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue // a metadata file that vanished mid-list — skip it, not fatal to the whole listing
		}
		var m metaFile
		if err := json.Unmarshal(data, &m); err != nil {
			continue
		}
		out = append(out, Backup{ID: id, SizeBytes: m.SizeBytes, SHA256: m.SHA256, CreatedAt: m.CreatedAt})
	}
	sort.Slice(out, func(i, k int) bool { return out[i].CreatedAt.After(out[k].CreatedAt) })
	return out, nil
}

func (p *LocalProvider) Delete(_ context.Context, serverUUID, backupID string) error {
	tarPath, err := p.backupPath(serverUUID, backupID)
	if err != nil {
		return err
	}
	_ = os.Remove(filepath.Join(p.serverDir(serverUUID), backupID+".json"))
	if err := os.Remove(tarPath); err != nil {
		if os.IsNotExist(err) {
			return ErrNotFound
		}
		return err
	}
	return nil
}

func (p *LocalProvider) Open(_ context.Context, serverUUID, backupID string) (io.ReadCloser, int64, error) {
	tarPath, err := p.backupPath(serverUUID, backupID)
	if err != nil {
		return nil, 0, err
	}
	f, err := os.Open(tarPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, 0, ErrNotFound
		}
		return nil, 0, err
	}
	stat, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, 0, err
	}
	return f, stat.Size(), nil
}
