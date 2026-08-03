# Music-software state terminology

> Point-in-time record. It is left as written, including the master level that
> was in scope when the question was asked. [ADR-0007](../adr/0007-remove-master-volume.md)
> later removed that control and is the authority on what Configuration holds.

## Question

What prior-art term best names Polynome's complete editable and persisted musical state: global tempo, master level, and the ordered Sequence of Cycles?

## Findings

There is strong prior art for the concept, but no universal term.

| Product | Complete-state term | What the official documentation establishes |
| --- | --- | --- |
| Ableton Live | **Live Set** | A Live Set is the document a user creates and works on, corresponding to one song; saving it stores its clips and settings. A **Live Project** is instead a folder that can contain multiple Live Sets and related assets. [Ableton: Managing Files and Sets](https://www.ableton.com/en/live-manual/12/managing-files-and-sets/) |
| Logic Pro | **Project** | Recordings and edits are saved with a project, and tempo, key, time signature, and project settings are project properties. [Apple: Save projects](https://support.apple.com/guide/logicpro/save-projects-lgcpce128e82/mac), [Apple: Project properties](https://support.apple.com/en-mide/guide/logicpro/lgcp8f5d126d/10.7/mac/11.0) |
| Pro Tools | **Session** | The session file is the editable Pro Tools document; session metadata includes BPM, and Pro Tools refers to session tempo and meter. [Avid: Pro Tools documentation](https://kb.avid.com/pkb/articles/en_US/user_guide/Pro-Tools-Documentation), [Avid: Pro Tools Reference Guide](https://resources.avid.com/SupportFiles/PT/Pro_Tools_Reference_Guide_2025.6.pdf) |
| Bitwig Studio | **Project** | The `.bwproject` file stores musical content and project-based parameters; the project has tempo and time-signature controls. Preferences remain application-wide rather than project state. [Bitwig: Working with Projects](https://www.bitwig.com/userguide/latest/working_with_projects_and_exporting/), [Bitwig: transport-area controls](https://www.bitwig.com/userguide/latest/the_window_menus_transport_area/) |
| REAPER | **Project** | Project settings include BPM, time signature, timebase, and other properties, and are saved with the project file. [REAPER User Guide](https://www.reaper.fm/userguide.php), [REAPER API](https://www.reaper.fm/sdk/reascript/reascripthelp.html) |
| Elektron Digitakt | **Project** | A project contains patterns plus general settings and states; loading one makes it the device's active working state. Patterns separately contain sequence data, BPM, length, swing, and time signature. [Digitakt User Manual, section 5.2](https://elektron.se/wp-content/uploads/2024/09/Digitakt_User_Manual_ENG_OS1.51_231108.pdf) |
| Roland MC-101 | **Project data** | The groovebox saves Project Data separately from Audio Data, and Roland describes creating and saving a project. [Roland MC-101](https://www.roland.com/global/products/mc-101/support/), [Roland video manual](https://www.roland.com/us/rtv/product_support/mc-101_video_manual/?lang=en-US) |
| Soundbrenner Metronome | **Song** | The library saves songs and organizes them into setlists. [Soundbrenner app manual](https://www.soundbrenner.com/pages/manual-the-metronome-app) |

## Distinctions

- **Project** is the broadest cross-product music-software precedent. Logic Pro, Bitwig, REAPER, Elektron, and Roland all use it for an editable or saved unit that combines musical structures with global or project-level settings.
- **Session** has valid Pro Tools precedent, but `CONTEXT.md` already reserves it as an avoided synonym for **Transport run**. Reusing it would make the domain less precise.
- **Set** is good Ableton precedent for a single lightweight musical document, but is less portable across products and can imply a live set containing several songs.
- **Song** is used by metronome software, but Polynome may represent an exercise or rhythm study rather than a song.
- **Document** accurately describes persistence, but is generic application vocabulary rather than domain language.
- **Preset** is a reusable starting point or narrower saved setting, not the current complete editable artifact. Polynome already has presets that produce state, so using it for the result would collapse two concepts.
- **Configuration** and **setup** usually describe technical or device settings. They understate that the object contains the user's musical Sequence.
- **State** is precise implementation language for the current in-memory value, but is not established user-facing music terminology.

## Recommendation

For the current product, use **Configuration** as internal implementation terminology and `configuration.js` as the dedicated deep module covering tempo, master level, Sequence construction and editing, normalization of persisted input, edit availability, transitions, and their transport consequences. Continue to use **Sequence** for the musical structure; Configuration is not a new user-facing domain term.

This fits Polynome's present interaction model: the application auto-persists one unnamed value and has no project, file, or library management. Although **Project** has the strongest broad music-software precedent, adopting it now would imply a user-visible artifact and management model that the product does not provide.

Defer **Metronome project** and `project.js` until Polynome introduces user-visible project, file, or library management. At that point the prior art above supports revisiting Project as the domain term without colliding with **Sequence**, **Rhythm layer**, or **Transport run**.
