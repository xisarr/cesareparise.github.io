# Editorial and source notes

These notes are for the site owner; they are not displayed on the website.

## Scope

The Model page has been replaced with a complete narrative and media layout.
The content of Home, Research, Publications, Patents and Contact is preserved.
The site navigation script has been extended to support subsection links and
references within the Model page. New CSS selectors are confined to that page.

The page introduces the computational/algorithmic distinction, the original
correlation detector, behavioural and neural tests, the transient input stage,
the population model, demonstrations, the distance case study and applied
research opportunities. The main narrative contains no mathematical derivation.
The original scientific diagram retains its own variable labels.

## Sources

The attached PDFs and perspective supplied the historical and mechanistic
narrative. The complete 2025 population-model article was read on eLife for
its results, parameter fitting, distance example, applications and limitations:
https://elifesciences.org/articles/106122

The transient-channel paper is linked to its published eLife record:
https://elifesciences.org/articles/90841
The supplied PDF's figure was used; its manuscript version predates the
published citation used on the page.

Other primary papers and the perspective are linked in the page bibliography.
The distance experiment is linked through its PubMed record:
https://pubmed.ncbi.nlm.nih.gov/15668388/

## Distinctions retained in the wording

- The published population study reports 69 experiments, 534 humans, 110 rats,
  two monkeys and a mean model-data correlation above 0.97. The page identifies
  this as a reported correlation, not a percentage accuracy score.
- The perspective's broad statement about no experiment-specific fitting is
  not used literally. The published Methods describe jointly estimated
  temporal filters and task-specific decision parameters. The page explicitly
  distinguishes a shared architecture and fixed filters in later tests from
  having no fitted parameters at all; rat temporal tuning also differs.
- The comparison concerns influential computational-level models used in this
  literature, not a categorical inability of Bayesian methods to process stimuli.
- The subjective 2016 classification tasks are described in terms of matching
  human stimulus-driven judgements, not as a proof that any ideal observer is
  mathematically incapable of generating a response.
- The MEG account distinguishes robust correlation-related effects from the
  more task-dependent evidence for lag-related signals.
- The McGurk account concerns integration and its timing dependence, not the
  identification of the reported phoneme or linguistic understanding.
- The distance example demonstrates a sufficient explanation of the tested
  effect using envelope structure; it does not show that the brain never
  represents distance or uses physical knowledge.
- Product-level speed, learning efficiency and commercial system improvements
  are proposed research questions, not claimed validation results.
- The key article's author/year is corrected to Cesare V. Parise (2025).

## Figure provenance

assets/mcd/population-model.png
: Original embedded Figure 1 artwork extracted from page 2 of the supplied
  Parise_2026_BPS_preprint (3).pdf. No data or diagram elements were redrawn.

assets/mcd/two-peaked-synchrony.png
: Crop of Figure 5d on PDF page 9 of elife-90841-v2.pdf. The axis labels and
  data/model content are retained. The caption notes the cyclic phase axis.

The distance result links directly to Figure 2B in the population paper;
no substitute data plot has been generated.

## Video provenance and processing

| Website file | Uploaded source | Content |
| --- | --- | --- |
| gaze.mp4 | Video_4.mp4 | Natural viewing and gaze |
| mcgurk.mp4 | Video_2.mp4 | McGurk demonstration |
| ventriloquist.mp4 | Video_3.mp4 | Ventriloquist demonstration |
| speech.mp4 | Video_1.mp4 | Natural speech and model responses |
| detector-animation.mp4 | 41467_2016_BFncomms11543_MOESM930_ESM.mov | Original detector animation, silent |

The uploaded speech/McGurk numbering differs from the published article, so
content-based filenames and captions are used rather than assuming the numbers
match. Poster images are frames from the corresponding supplied clips.

Video was recompressed as browser-friendly H.264, preserving the source
geometry, frame rate, start times and per-stream duration. Audio streams were
copied, not re-encoded; checksums of all four audio streams match their sources.
No frames were deliberately cut or retimed and no audio lag was introduced.
The videos retain their original scientific annotations.

## Local implementation checks

- Unique HTML IDs and valid new internal link targets.
- Existing five non-Model page sections unchanged.
- No horizontal overflow at 320, 390, 768, 1024 or 1280 pixels in Chromium.
- Working section links, expandable paper references and Contact action.
- All five videos load and play, with single-video playback control.
- All local scientific images decode and render.
- No JavaScript runtime errors in those checks.

The previews are local renders of the supplied implementation. The website has
not been published to GitHub or tested on the live domain. Existing profile and
research-page images must remain in the user's repository, as noted in README.
