MCD WEBSITE UPDATE
==================

WHAT IS INCLUDED
- index.html: your uploaded website with the Multisensory Model page completed.
- assets/mcd/: all new figures, video files and poster images used on that page.
- MCD_page_copy.md: a reading/editing copy of the page's text.
- EDITORIAL_NOTES.md: source mappings, editorial choices and validation notes.

INSTALL
1. Back up your current index.html.
2. Copy the supplied index.html into the root of your existing website,
   replacing the old index.html.
3. Copy the assets/mcd folder into that same website. Merge with any existing
   assets folder; do not remove other assets.
4. Keep your existing photo.jpg, MCD_capture.png, PNAS_capture_small.png,
   CHI_capture.png and any other existing files. They are not included in this
   update because they belong to the existing site.
5. Preview the site and choose "Multisensory Model" in the navigation, or append
   #model to its address. Publish the new index.html AND assets/mcd together.

This is an update package, not a replacement for your entire repository.

LAYOUT
The new styling is confined to #page-model, preserving the design and content
of the other pages. The original six top-level navigation destinations remain.
The small navigation script now also supports links to subsections and paper
references within the model page. Reference links open their enclosing details
panel automatically. External links and email links are not intercepted.

MEDIA
Five videos and two scientific figures are included. Videos do not autoplay;
readers choose when to start playback and sound. Only one model video plays at
a time. Playback pauses when the user leaves the Model page or closes its
containing panel. The original frame rates, durations, dimensions and audio
streams have been retained. The detector animation is silent in the source.
All new files together are approximately 14 MB before ZIP compression.

READING COPY
MCD_page_copy.md contains the same text and source links. It is a companion for
reviewing the wording; editing it does not automatically change index.html.

CHECKS
The integrated page was checked in Chromium at viewport widths of 320, 390,
768, 1024 and 1280 pixels. No horizontal overflow or JavaScript errors were
found. In-page navigation, paper references, the contact call-to-action and
all five video files were tested locally. This is not a live deployment or
a cross-browser/device timing calibration. Browser playback should not be
used as a substitute for a calibrated psychophysical setup.

No packages, frameworks, icon libraries or build commands are required.
