#!/usr/bin/env python3
"""Validate raw capture packages written by `retake export-capture` / `retake run --raw` (lot L2.13).

Optional tool, not part of the build or the test suite. Each package folder is checked against its own
`manifest.json`:

  1. every clip and cursor layer with ffprobe (frames counted with -count_frames, codec / profile / pix_fmt, size,
     frame rate, duration, start timecode = place on the sequence, BT.709 tv range), cuts inside their clip, the
     primary clips back to back on the sequence, the selects file;
  2. the FCPXML: well-formed, version 1.10, every time on the frame grid, spine offsets / durations, asset starts =
     the clips' timecodes, media paths, connected layers (ProRes: at their own timecode; WebM: never), markers inside
     their clips and as many as the manifest counts;
  3. the OTIO, read back with OpenTimelineIO: V1 clips at their sequence positions, available range = timecode,
     `file://` URLs, every other track's clip against its media (start = its timecode, or 0 for WebM; frame count),
     markers inside their clips;
  4. the CMX 3600 EDL read with OpenTimelineIO's cmx_3600 adapter at the package rate: events and LOC locators;
  5. the FCPXML again through OpenTimelineIO's fcpx_xml adapter (best effort);
  6. markers.csv = markers.json, sequence frames and timecodes consistent.

Needs ffprobe on PATH (or $RETAKE_FFPROBE) and, for steps 3–5, the `opentimelineio` package with its EDL and
FCPXML adapter plugins (OpenTimelineIO ≥ 0.17 ships them separately) — not repository dependencies. Without them those
steps are skipped with a note. Set them up once in a virtual environment, e.g.:

    python3 -m venv ~/.venvs/otio
    ~/.venvs/otio/bin/pip install opentimelineio otio-cmx3600-adapter otio-fcpx-xml-adapter
    ~/.venvs/otio/bin/python scripts/validate-raw.py projects/<project>/exports/<package> [...more packages]

Exit status: 0 when every package passes, 1 when one fails, 2 on a usage error.
"""
import argparse
import csv
import json
import os
import subprocess
import sys
import xml.etree.ElementTree as ET
from fractions import Fraction
from urllib.parse import unquote, urlparse

try:
    import opentimelineio as otio
except ImportError:  # optional: steps 3–5 are skipped
    otio = None

FFPROBE = os.environ.get('RETAKE_FFPROBE', 'ffprobe')
EXPECTED_CODEC = {'mp4': ('h264', 'High', 'yuv420p'), 'prores': ('prores', 'HQ', 'yuv422p10le')}
ALPHA_PIX_FMTS = ('yuva444p10le', 'yuva444p12le', 'yuva420p', 'yuv420p')


def tc_to_frames(tc, rate):
    h, mi, s, f = (int(x) for x in tc.split(':'))
    return ((h * 60 + mi) * 60 + s) * rate + f


def probe(path):
    out = subprocess.run(
        [FFPROBE, '-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries',
         'stream=codec_name,profile,pix_fmt,width,height,r_frame_rate,nb_read_frames,color_range,color_space'
         ':stream_tags=timecode,alpha_mode:format=duration', '-of', 'json', path],
        capture_output=True, text=True, check=True).stdout
    j = json.loads(out)
    return j['streams'][0], float(j['format']['duration'])


def rat(v):
    """An FCPXML rational time ('1001/30000s', '5s') as a Fraction of seconds."""
    if not v.endswith('s'):
        raise ValueError(f'not an FCPXML time: {v}')
    v = v[:-1]
    return Fraction(v) if '/' in v else Fraction(int(v))


def file_path(url):
    u = urlparse(url)
    return u.scheme, unquote(u.path)


class Package:
    def __init__(self, folder):
        self.dir = os.path.abspath(folder)
        self.m = json.load(open(os.path.join(self.dir, 'manifest.json')))
        self.fps = self.m['sequence']['fps']
        self.frame = Fraction(1, self.fps)
        self.webm = self.m['settings'].get('layer') == 'webm'
        self.primaries = [c for c in self.m['clips'] if c['primary']]
        self.seq_frames = sum(c['frames'] for c in self.primaries)
        self.total_markers = sum(self.m['markers']['count'].values())
        self.errors = []
        self.info = []

    def err(self, msg):
        self.errors.append(msg)

    def path(self, rel):
        return os.path.join(self.dir, rel)

    # 1. Clips and layers against the manifest
    def check_clips(self):
        m, fps = self.m, self.fps
        expect = EXPECTED_CODEC[m['settings']['format']]
        for c in m['clips']:
            s, dur = probe(self.path(c['file']))
            n = int(s['nb_read_frames'])
            num, den = (int(x) for x in s['r_frame_rate'].split('/'))
            tcode = s.get('tags', {}).get('timecode')
            if n != c['frames']:
                self.err(f"{c['file']}: ffprobe counts {n} frames, the manifest {c['frames']}")
            if Fraction(num, den) != fps:
                self.err(f"{c['file']}: frame rate {s['r_frame_rate']} != {fps}")
            if (s['codec_name'], s.get('profile'), s['pix_fmt']) != expect:
                self.err(f"{c['file']}: {s['codec_name']} {s.get('profile')} {s['pix_fmt']} != {expect}")
            if abs(dur - n / fps) > 0.5 / fps:
                self.err(f"{c['file']}: duration {dur:.4f} s != {n} frames / {fps}")
            if tcode != c['seq_start_tc']:
                self.err(f"{c['file']}: timecode {tcode} != {c['seq_start_tc']}")
            if (s['width'], s['height']) != (c['width'], c['height']):
                self.err(f"{c['file']}: size {s['width']}x{s['height']} != {c['width']}x{c['height']}")
            if (s['codec_name'] == 'h264' and s.get('color_range') != 'tv') or s.get('color_space') != 'bt709':
                self.err(f"{c['file']}: colour {s.get('color_range')} {s.get('color_space')} (expected BT.709 tv)")
            for x in c['cuts']:
                if not (0 < x['at_frame'] < c['frames']):
                    self.err(f"{c['file']}: cut at frame {x['at_frame']} not inside the clip (1..{c['frames'] - 1})")
            if 'layer' in c:
                ls, _ = probe(self.path(c['layer']['file']))
                ln = int(ls['nb_read_frames'])
                if ln != c['frames']:
                    self.err(f"{c['layer']['file']}: {ln} frames != its clip's {c['frames']}")
                if ls['pix_fmt'] not in ALPHA_PIX_FMTS:
                    self.err(f"{c['layer']['file']}: pix_fmt {ls['pix_fmt']} has no alpha")
                if ls['codec_name'] == 'prores' and ls.get('tags', {}).get('timecode') != c['seq_start_tc']:
                    self.err(f"{c['layer']['file']}: timecode {ls.get('tags', {}).get('timecode')} != {c['seq_start_tc']}")
                self.info.append(f"layer {c['layer']['file']}: {ls['codec_name']} {ls.get('profile')} {ls['pix_fmt']} {ln} frames")
            self.info.append(f"clip {c['file']}: {s['codec_name']} {s.get('profile')} {s['pix_fmt']} {s['width']}x{s['height']} "
                             f"{s['r_frame_rate']} {n} frames {dur:.3f} s tc {tcode}, {len(c['cuts'])} cut(s)")
        if self.seq_frames != m['sequence']['frames']:
            self.err(f"sequence frames {m['sequence']['frames']} != sum of the primary clips {self.seq_frames}")
        pos = 0
        for c in self.primaries:
            if c['seq_start_frame'] != pos:
                self.err(f"{c['file']}: sequence start {c['seq_start_frame']} != {pos}")
            pos += c['frames']
        if m.get('selects'):
            s, dur = probe(self.path(m['selects']['file']))
            if int(s['nb_read_frames']) != self.seq_frames:
                self.err(f"selects: {s['nb_read_frames']} frames != {self.seq_frames}")
            self.info.append(f"selects: {s['nb_read_frames']} frames {dur:.3f} s")

    # 2. FCPXML
    def check_fcpxml(self):
        frame = self.frame
        fx = self.path(self.m['markers']['fcpxml'])
        root = ET.parse(fx).getroot()
        if root.tag != 'fcpxml' or root.get('version') != '1.10':
            self.err(f"FCPXML root <{root.tag} version={root.get('version')}> (expected fcpxml 1.10)")
        for el in root.iter():
            for a in ('start', 'duration', 'offset', 'tcStart', 'posterOffset'):
                if a in el.attrib and (rat(el.get(a)) / frame).denominator != 1:
                    self.err(f"FCPXML {el.tag}@{a}={el.get(a)} is not on the {self.fps} fps frame grid")
        resources = root.find('resources')
        formats = {f.get('id'): f for f in resources.findall('format')}
        for f in formats.values():
            if rat(f.get('frameDuration')) != frame:
                self.err(f"FCPXML format {f.get('id')} frameDuration {f.get('frameDuration')}")
        assets = {a.get('id'): a for a in resources.findall('asset')}
        seq = root.find('library/event/project/sequence')
        clips = seq.find('spine').findall('asset-clip')
        if len(clips) != len(self.primaries):
            self.err(f"FCPXML spine has {len(clips)} clips, the manifest {len(self.primaries)} primary clips")
        if rat(seq.get('duration')) != self.seq_frames * frame:
            self.err(f"FCPXML sequence duration {seq.get('duration')} != {self.seq_frames} frames")
        markers = 0
        for ac, c in zip(clips, self.primaries):
            a = assets[ac.get('ref')]
            _, src = file_path(a.find('media-rep').get('src'))
            if src != self.path(c['file']):
                self.err(f"FCPXML asset {a.get('name')}: src {src}")
            if rat(ac.get('offset')) != c['seq_start_frame'] * frame or rat(ac.get('duration')) != c['frames'] * frame:
                self.err(f"FCPXML clip {ac.get('name')}: offset {ac.get('offset')} duration {ac.get('duration')}")
            if rat(a.get('start')) != tc_to_frames(c['timecode'], self.fps) * frame or rat(a.get('duration')) != c['frames'] * frame:
                self.err(f"FCPXML asset {a.get('name')}: start {a.get('start')} duration {a.get('duration')} vs timecode {c['timecode']}")
            start = rat(ac.get('start'))
            for mk in list(ac.findall('marker')) + list(ac.findall('chapter-marker')):
                markers += 1
                if not (start <= rat(mk.get('start')) < start + c['frames'] * frame):
                    self.err(f"FCPXML marker '{mk.get('value')}' at {mk.get('start')} outside clip {ac.get('name')}")
            for conn in ac.findall('asset-clip'):
                ca = assets[conn.get('ref')]
                if rat(conn.get('offset')) != start:
                    self.err(f"FCPXML connected clip {conn.get('name')}: offset {conn.get('offset')} != parent start {ac.get('start')}")
                if conn.get('name', '').endswith('-cursor'):
                    if self.webm:
                        self.err(f"FCPXML lists the WebM cursor layer {conn.get('name')} (WebM has no timecode)")
                    _, lfile = file_path(ca.find('media-rep').get('src'))
                    ls, _ = probe(lfile)
                    ltc = ls.get('tags', {}).get('timecode')
                    if ltc is None or rat(ca.get('start')) != tc_to_frames(ltc, self.fps) * frame or rat(conn.get('start')) != rat(ca.get('start')):
                        self.err(f"FCPXML layer {conn.get('name')}: start {ca.get('start')} / {conn.get('start')} vs media timecode {ltc}")
        if markers != self.total_markers:
            self.err(f"FCPXML has {markers} markers, the manifest {self.total_markers}")
        self.info.append(f"FCPXML: {len(clips)} spine clips, {len(assets)} assets, {len(formats)} formats, {markers} markers, "
                         f"sequence {seq.get('duration')}")

    # 3. OTIO read back
    def check_otio(self):
        fps = self.fps
        tl = otio.adapters.read_from_file(self.path(self.m['markers']['otio']))
        v1 = tl.tracks[0]
        oclips = [x for x in v1 if isinstance(x, otio.schema.Clip)]
        if len(oclips) != len(self.primaries):
            self.err(f"OTIO V1 has {len(oclips)} clips, the manifest {len(self.primaries)}")
        if v1.duration().value != self.seq_frames or v1.duration().rate != fps:
            self.err(f"OTIO V1 duration {v1.duration()}")
        markers = 0
        for oc, c in zip(oclips, self.primaries):
            sr = oc.source_range
            if sr.duration.value != c['frames'] or sr.start_time.value != tc_to_frames(c['timecode'], fps):
                self.err(f"OTIO {oc.name}: source range {sr}")
            if oc.media_reference.available_range != sr:
                self.err(f"OTIO {oc.name}: available range {oc.media_reference.available_range}")
            scheme, p = file_path(oc.media_reference.target_url)
            if scheme != 'file' or p != self.path(c['file']):
                self.err(f"OTIO {oc.name}: url {oc.media_reference.target_url}")
            if v1.range_of_child(oc).start_time.value != c['seq_start_frame']:
                self.err(f"OTIO {oc.name}: at {v1.range_of_child(oc).start_time.value} != {c['seq_start_frame']}")
            for mk in oc.markers:
                markers += 1
                if not sr.contains(mk.marked_range.start_time):
                    self.err(f"OTIO marker '{mk.name}' outside its clip {oc.name}")
        if markers != self.total_markers:
            self.err(f"OTIO has {markers} markers, the manifest {self.total_markers}")
        self.info.append(f"OTIO: {len(tl.tracks)} tracks ({', '.join(t.name for t in tl.tracks)}), V1 {len(oclips)} clips "
                         f"{v1.duration().value:g} frames, {markers} markers")
        layers = 0
        for t in tl.tracks[1:]:
            if t.duration().value > self.seq_frames:
                self.err(f"OTIO track {t.name} is longer than the sequence")
            for oc in [x for x in t if isinstance(x, otio.schema.Clip)]:
                scheme, p = file_path(oc.media_reference.target_url)
                if scheme != 'file' or not os.path.exists(p):
                    self.err(f"OTIO {t.name}/{oc.name}: url {oc.media_reference.target_url}")
                    continue
                ls, _ = probe(p)
                ltc = ls.get('tags', {}).get('timecode')
                media0 = tc_to_frames(ltc, fps) if ltc else 0
                sr = oc.source_range
                if sr.start_time.value != media0 or oc.media_reference.available_range.start_time.value != media0:
                    self.err(f"OTIO {t.name}/{oc.name}: source start {sr.start_time.value} / available "
                             f"{oc.media_reference.available_range.start_time.value} != media start {media0} (tc {ltc})")
                if int(ls['nb_read_frames']) != sr.duration.value:
                    self.err(f"OTIO {t.name}/{oc.name}: {ls['nb_read_frames']} frames in the file, {sr.duration.value:g} referenced")
                if oc.name.endswith('-cursor'):
                    layers += 1
                owner = next((c for c in self.m['clips'] if self.path(c['file']) == p
                              or self.path(c.get('layer', {}).get('file', '-')) == p), None)
                if owner is None:
                    self.err(f"OTIO {t.name}/{oc.name}: {p} is not a file of the package")
                elif t.range_of_child(oc).start_time.value != owner['seq_start_frame']:
                    self.err(f"OTIO {t.name}/{oc.name}: at {t.range_of_child(oc).start_time.value} != {owner['seq_start_frame']}")
        if self.m['cursor']['mode'] == 'layer':
            self.info.append(f"OTIO: {layers} cursor layers checked against their media ({'WebM: from 0' if self.webm else 'ProRes: their timecode'})")

    # 4. EDL through the cmx_3600 adapter
    def check_edl(self):
        if 'cmx_3600' not in otio.adapters.available_adapter_names():
            self.info.append('EDL: not read back (pip install otio-cmx3600-adapter)')
            return
        edl = otio.adapters.read_from_file(self.path(self.m['markers']['edl']), adapter_name='cmx_3600', rate=self.fps)
        track = edl.tracks[0]
        eclips = [x for x in track if isinstance(x, otio.schema.Clip)]
        if len(eclips) != len(self.primaries):
            self.err(f"EDL has {len(eclips)} events, the manifest {len(self.primaries)} primary clips")
        locators = 0
        for ec, c in zip(eclips, self.primaries):
            sr = ec.source_range
            if sr.duration.value != c['frames'] or sr.start_time.value != c['seq_start_frame']:
                self.err(f"EDL {ec.name}: source range {sr}")
            if track.range_of_child(ec).start_time.value != c['seq_start_frame']:
                self.err(f"EDL {ec.name}: record start {track.range_of_child(ec).start_time.value}")
            for mk in ec.markers:
                locators += 1
                if not sr.contains(mk.marked_range.start_time):
                    self.err(f"EDL locator '{mk.name}' outside its event {ec.name}")
        if locators != self.total_markers:
            self.err(f"EDL has {locators} locators, the manifest {self.total_markers} markers")
        self.info.append(f"EDL: {len(eclips)} events, {locators} locators, record {track.duration().value:g} frames")

    # 5. FCPXML through the fcpx_xml adapter (it targets older FCPXML: best effort, never an error by itself)
    def check_fcpx_adapter(self):
        if 'fcpx_xml' not in otio.adapters.available_adapter_names():
            self.info.append("FCPXML via OTIO's fcpx_xml adapter: not read (pip install otio-fcpx-xml-adapter)")
            return
        try:
            fo = otio.adapters.read_from_file(self.path(self.m['markers']['fcpxml']), adapter_name='fcpx_xml')
        except Exception as e:  # noqa: BLE001
            self.info.append(f"FCPXML via OTIO's fcpx_xml adapter: not read ({type(e).__name__}: {e})")
            return
        tl = fo if isinstance(fo, otio.schema.Timeline) else next(iter(fo))
        v = tl.tracks[0]
        n = len([x for x in v if isinstance(x, otio.schema.Clip)])
        self.info.append(f"FCPXML via OTIO's fcpx_xml adapter: {len(tl.tracks)} tracks, track 1 {n} clips, "
                         f"{v.duration().value:g} frames @ {v.duration().rate:g}")
        if round(v.duration().to_frames(self.fps)) != self.seq_frames:
            self.err(f"FCPXML via the fcpx_xml adapter: duration {v.duration()} != {self.seq_frames} frames")

    # 6. markers.csv / markers.json
    def check_marker_lists(self):
        mj = json.load(open(self.path(self.m['markers']['json'])))['markers']
        rows = list(csv.DictReader(open(self.path(self.m['markers']['csv']))))
        if len(mj) != self.total_markers:
            self.err(f"markers.json has {len(mj)} markers, the manifest {self.total_markers}")
        if len(rows) != self.total_markers:
            self.err(f"markers.csv has {len(rows)} rows, the manifest {self.total_markers} markers")
        for r, j in zip(rows, mj):
            if int(r['seq_frame']) != j['seq_frame'] or r['seq_tc'] != j['seq_tc']:
                self.err(f"markers.csv and markers.json differ at '{r['name']}'")
            clip = next((c for c in self.m['clips'] if c['file'] == j['clip']), None)
            if clip is None:
                self.err(f"marker '{j['name']}': unknown clip {j['clip']}")
                continue
            if j['seq_frame'] != clip['seq_start_frame'] + j['clip_frame']:
                self.err(f"marker '{j['name']}': sequence frame {j['seq_frame']} != clip start + {j['clip_frame']}")
            if tc_to_frames(j['seq_tc'], self.fps) != j['seq_frame']:
                self.err(f"marker '{j['name']}': timecode {j['seq_tc']} != frame {j['seq_frame']}")

    def run(self):
        self.check_clips()
        self.check_fcpxml()
        if otio is not None:
            self.check_otio()
            self.check_edl()
            self.check_fcpx_adapter()
        self.check_marker_lists()
        return not self.errors


def main(argv):
    ap = argparse.ArgumentParser(description='Validate Retake raw capture packages (retake export-capture).')
    ap.add_argument('packages', nargs='+', help='package folders (exports/<run>-raw-<format><fps>-<cursor>/)')
    ap.add_argument('-q', '--quiet', action='store_true', help='print only the verdict and the errors')
    args = ap.parse_args(argv)
    if otio is None:
        print('note: opentimelineio is not installed: the OTIO / EDL read-back (steps 3–5) is skipped '
              '(pip install opentimelineio otio-cmx3600-adapter otio-fcpx-xml-adapter in a virtual environment)')
    ok = True
    for folder in args.packages:
        if not os.path.isfile(os.path.join(folder, 'manifest.json')):
            print(f'error: {folder} has no manifest.json (not a raw package)', file=sys.stderr)
            return 2
        pkg = Package(folder)
        try:
            passed = pkg.run()
        except (subprocess.CalledProcessError, FileNotFoundError, ET.ParseError, KeyError, ValueError) as e:
            pkg.err(f'{type(e).__name__}: {e}')
            passed = False
        if not args.quiet:
            for line in pkg.info:
                print('  ' + line)
        print(f"{'OK  ' if passed else 'FAIL'} {pkg.dir}: {len(pkg.m['clips'])} clips, {pkg.total_markers} markers"
              f"{'' if otio else ' (without the OTIO / EDL read-back)'}")
        for e in pkg.errors:
            print('  ERROR ' + e)
        ok = ok and passed
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
