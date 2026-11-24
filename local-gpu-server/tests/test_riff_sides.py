"""
Unit tests for the left / right guitar logic of the riff transcriber (no audio needed).

  .venv\\Scripts\\python.exe -m unittest discover -s tests -v      (from local-gpu-server)
"""

import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from stemforge_server.riff import (  # noqa: E402
    SPLIT_MIN_NOTES,
    NoteEvent,
    merge_performances,
    same_part,
    side_agreement,
    side_parts,
    sides_differ,
)

STEP = 0.125  # 16th notes at 120 BPM


def riff(pitches, start=0.0, offset=0.0, clarity=0.9):
    """One guitar playing `pitches` (a pitch tuple per attack) as 16th notes."""
    return [NoteEvent(start + i * STEP + offset, start + (i + 1) * STEP + offset - 0.01, tuple(p), 100, clarity) for i, p in enumerate(pitches)]


class SamePartTest(unittest.TestCase):
    def test_power_chord_variants_are_the_same_part(self):
        self.assertTrue(same_part((40, 47), (40, 47, 52)))  # with / without the octave
        self.assertTrue(same_part((40,), (40, 47)))  # root under the power chord
        self.assertTrue(same_part((40, 47), (40, 44, 47)))  # a chord that contains the other's power chord
        self.assertTrue(same_part((40,), (40,)))

    def test_different_notes_are_different_parts(self):
        self.assertFalse(same_part((40,), (47,)))  # doubled a fifth up
        self.assertFalse(same_part((57,), (60,)))  # harmony in thirds
        self.assertFalse(same_part((40,), (52,)))  # octave part
        self.assertFalse(same_part((40, 47), (43, 47)))  # different root
        self.assertFalse(same_part((), (40,)))


class MergeTest(unittest.TestCase):
    def test_merge_joins_close_attacks_without_touching_the_inputs(self):
        left = riff([(40,), (40,), (43,)])
        right = riff([(47,), (47,), (50,)], offset=0.02)  # the right guitar hits 20 ms later
        before = [(e.start, e.end, e.pitches) for e in left + right]
        merged = merge_performances(left, right)
        self.assertEqual([e.pitches for e in merged], [(40, 47), (40, 47), (43, 50)])
        self.assertAlmostEqual(merged[0].start, 0.0)
        self.assertEqual([(e.start, e.end, e.pitches) for e in left + right], before)

    def test_unpaired_attacks_are_copies(self):
        left = riff([(40,)])
        merged = merge_performances(left, [])
        merged[0].end = 99.0
        self.assertNotEqual(left[0].end, 99.0)


class AgreementTest(unittest.TestCase):
    def test_unison_double_tracks_do_not_split(self):
        notes = [(40,), (40,), (43,), (45,)] * 30
        st = side_agreement(riff(notes), riff(notes, offset=0.015))
        self.assertEqual(st["sidePairs"], len(notes))
        self.assertEqual(st["sideDiffer"], 0)
        self.assertFalse(sides_differ(st))

    def test_scattered_errors_do_not_split(self):
        notes = [(40,), (40,), (43,), (45,)] * 30
        wrong = list(notes)
        for i in range(0, len(wrong), 7):  # one side misreads every 7th note
            wrong[i] = (wrong[i][0] + 1,)
        st = side_agreement(riff(notes), riff(wrong, offset=0.01))
        self.assertGreater(st["sideDiffer"], 10)
        self.assertFalse(sides_differ(st))

    def test_a_harmonised_section_splits(self):
        unison = [(40,), (40,), (43,), (45,)] * 16
        melody = [(57,), (59,), (60,), (62,)] * 10
        third = [(60,), (62,), (64,), (65,)] * 10
        left = riff(unison + melody + unison)
        right = riff(unison + third + unison, offset=0.02)
        st = side_agreement(left, right)
        self.assertGreaterEqual(st["sideDifferInStretches"], SPLIT_MIN_NOTES)
        self.assertTrue(sides_differ(st))

    def test_unclear_pitches_are_ignored(self):
        notes = [(40,)] * 60
        st = side_agreement(riff(notes, clarity=0.3), riff([(47,)] * 60, clarity=0.3))
        self.assertEqual(st["sidePairs"], 0)
        self.assertFalse(sides_differ(st))


class SidePartsTest(unittest.TestCase):
    def _unison_then_harmony(self):
        unison = [(40, 47)] * 40
        left_unison = list(unison)
        left_unison[5] = (40,)  # the left take only shows the root here; the right shows the power chord
        melody, third = [(57,), (59,), (60,), (62,)] * 10, [(60,), (62,), (64,), (65,)] * 10
        left = riff(left_unison + melody)
        right = riff(unison + third, offset=0.02)
        del right[12]  # an attack the right side's onset detector missed in the unison part
        return left, right, melody, third

    def test_unison_sections_lend_missed_attacks_but_never_the_other_guitars_notes(self):
        left, right, melody, third = self._unison_then_harmony()
        lp, rp = side_parts(left, right)
        # each guitar keeps its own notes at attacks both heard (no union with the other guitar)...
        self.assertEqual(lp[5].pitches, (40,))
        self.assertEqual(rp[5].pitches, (40, 47))
        # ...and an attack only one side heard in a unison section goes to both parts
        self.assertEqual(len(lp), len(rp))
        self.assertEqual(rp[12].pitches, (40, 47))
        # harmony: each part keeps its own notes
        self.assertEqual([e.pitches for e in lp[-8:]], melody[-8:])
        self.assertEqual([e.pitches for e in rp[-8:]], third[-8:])

    def test_unison_modes(self):
        left, right, _, _ = self._unison_then_harmony()
        lp, rp = side_parts(left, right, unison="notes")  # merged notes in unison sections
        self.assertEqual(lp[5].pitches, (40, 47))
        self.assertEqual(rp[12].pitches, (40, 47))
        lp, rp = side_parts(left, right, unison="off")  # strictly each side's own detections
        self.assertEqual(lp[5].pitches, (40,))
        self.assertEqual(len(rp), len(right))

    def test_one_guitar_alone_stays_in_its_own_part(self):
        intro = [(40,), (40,), (43,), (45,)] * 12  # left guitar plays the intro alone
        both = [(40,), (40,), (43,), (45,)] * 12
        left = riff(intro + both)
        right = riff(both, start=len(intro) * STEP, offset=0.01)
        lp, rp = side_parts(left, right)
        self.assertEqual(len(lp), len(intro) + len(both))
        self.assertTrue(all(e.start >= len(intro) * STEP - 0.05 for e in rp), "the right part must not get the left guitar's intro")
        self.assertEqual(len(rp), len(both))

    def test_octave_error_in_a_differing_section_takes_the_clearer_side(self):
        left_notes = [(57,), (59,), (60,), (62,)] * 10
        right_notes = [(60,), (62,), (64,), (65,)] * 10
        left = riff(left_notes)
        right = riff(right_notes, offset=0.01)
        right[6] = NoteEvent(right[6].start, right[6].end, (72,), 100, 0.6)  # left plays 60 clearly
        stats = {}
        lp, rp = side_parts(left, right, stats=stats)
        self.assertEqual(rp[6].pitches, (60,))
        self.assertEqual(stats.get("sideOctaveFixed"), 1)
        self.assertEqual(right[6].pitches, (72,), "inputs are not modified")

    def test_parts_never_overlap_their_next_attack(self):
        left = riff([(40, 47)] * 40)
        right = riff([(40, 47)] * 40, offset=0.03)
        for part in side_parts(left, right):
            for a, b in zip(part, part[1:]):
                self.assertLessEqual(a.end, b.start + 1e-9)


def tone(midi, dur, sr=22050, partials=6):
    t = np.arange(int(dur * sr)) / sr
    f = 440.0 * 2 ** ((midi - 69) / 12)
    return sum(np.sin(2 * np.pi * h * f * t) / h for h in range(1, partials + 1)).astype(np.float32)


class SplitTest(unittest.TestCase):
    """The left / right split on two synthetic guitars that leak into each other's side (-12 dB)."""

    def setUp(self):
        self.sr = 22050
        leak = 10 ** (-12 / 20)
        a = np.concatenate([tone(40, 1.0), tone(43, 1.0)])  # left guitar: E2, then G2
        b = np.concatenate([tone(47, 1.0), np.zeros(self.sr, np.float32)])  # right guitar: B2, then rests
        rng = np.random.default_rng(1)
        smear = lambda x: np.convolve(x, rng.normal(0, 1, 200) / np.sqrt(200), mode="same").astype(np.float32)  # noqa: E731
        self.stereo = np.stack([a + leak * smear(b), b + leak * smear(a)])
        self.a, self.b = a, b

    def test_tracks_add_up_to_the_stem_and_hold_their_own_guitar(self):
        from stemforge_server import sides

        g1, g2, info = sides.split_left_right(self.stereo, self.sr)
        np.testing.assert_allclose(g1 + g2, self.stereo, atol=1e-5)
        self.assertTrue(sides.should_split(self.stereo))

        def level(x, midi, t0):
            seg = x[int(t0 * self.sr) : int((t0 + 0.4) * self.sr)]
            spec = np.abs(np.fft.rfft(seg * np.hanning(len(seg))))
            k = int(round(440.0 * 2 ** ((midi - 69) / 12) * len(seg) / self.sr))
            return 20 * np.log10(spec[k - 1 : k + 2].max() + 1e-9)

        # the right guitar's B2 in the left guitar's track: -12 dB of leakage before, far less after
        before = level(self.stereo[0], 47, 0.3) - level(self.stereo[0], 40, 0.3)
        after = level(g1[0] + g1[1], 47, 0.3) - level(g1[0] + g1[1], 40, 0.3)
        self.assertLess(after, before - 10)
        # while the right guitar rests, its track is (nearly) silent: the left guitar's leak moved over
        rest = slice(int(1.2 * self.sr), int(1.9 * self.sr))
        self.assertLess(float(np.sum(g2[:, rest] ** 2)), 0.05 * float(np.sum(self.stereo[1, rest] ** 2)))

    def test_ownership_drops_the_other_guitars_leak_from_a_part(self):
        from stemforge_server import sides

        owner = sides.Ownership(self.stereo, self.sr)
        self.assertGreater(owner.share(0, 0.1, 0.9, 40), 0.8)  # the left guitar's own E2
        self.assertGreater(owner.share(1, 0.1, 0.9, 47), 0.8)  # the right guitar's own B2
        # in the right channel during its rest, the "G2" is the left guitar leaking in
        self.assertLess(owner.share(1, 1.1, 1.9, 43), 0.3)
        kept, dropped = owner.filter([[1.1, 1.9, 43, 90], [0.1, 0.9, 47, 100]], 1)
        self.assertEqual(dropped, 1)
        self.assertEqual(kept, [[0.1, 0.9, 47, 100]])


if __name__ == "__main__":
    unittest.main()
