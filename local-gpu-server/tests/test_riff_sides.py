"""
Unit tests for the left / right guitar logic of the riff transcriber (no audio needed).

  .venv\\Scripts\\python.exe -m unittest discover -s tests -v      (from local-gpu-server)
"""

import sys
import unittest
from pathlib import Path

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
    def test_unison_sections_share_the_merged_notes_and_harmonies_keep_their_own(self):
        unison = [(40, 47)] * 40
        left_unison = list(unison)
        left_unison[5] = (40,)  # the left take only shows the root here; the right shows the power chord
        melody, third = [(57,), (59,), (60,), (62,)] * 10, [(60,), (62,), (64,), (65,)] * 10
        left = riff(left_unison + melody)
        right = riff(unison + third, offset=0.02)
        del right[12]  # an attack the right side's onset detector missed in the unison part
        lp, rp = side_parts(left, right)
        n_unison = len(unison)
        # unison: both parts get the merged notes, including the attack only one side heard
        self.assertEqual(len(lp), len(rp))
        self.assertEqual(lp[5].pitches, (40, 47))
        self.assertEqual(rp[12].pitches, (40, 47))
        self.assertEqual([e.pitches for e in lp[: n_unison - 4]], [e.pitches for e in rp[: n_unison - 4]])
        # harmony: each part keeps its own notes
        self.assertEqual([e.pitches for e in lp[-8:]], melody[-8:])
        self.assertEqual([e.pitches for e in rp[-8:]], third[-8:])

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


if __name__ == "__main__":
    unittest.main()
