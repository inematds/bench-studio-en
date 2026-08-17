# UGC prompting in Bench

UGC is a creative intent, not one universal prompt. Bench keeps the workflow simple with a single `UGC ad` mode, then adapts the rewrite to the selected model family and lane.

## The shared brief

Every UGC rewrite starts from the same production constraint:

- one creator
- one product
- one setting
- one clear beat
- phone-native framing and natural light
- hook or problem → product interaction or proof → reaction/payoff
- one short spoken line only when the model supports audio
- no invented claims, extra people, montage, captions, or scene changes unless requested

Short model generations should be treated as one usable shot, not a complete 30-second ad. Build the final ad by chaining several short beats in the edit.

## Model-family adapters

| Family | UGC rewrite shape | Important constraint |
| --- | --- | --- |
| FLUX.2 | Candid phone/digicam creator still, subject → action → setting → light | Positive prose only; no negative prompt. |
| Nano Banana | Natural scene description with reference roles | Preserve attached product/face; quote only short requested copy. |
| GPT Image | Compact designer brief | Avoid dense typography and pixel-exact layout promises. |
| Recraft | Concise controlled art direction | Specify creator, product, composition, style, and any short headline. |
| Seedream / Qwen | Concrete creator + product action + simple social composition | Avoid keyword soup, dense props, and ad-buzzword piles. |
| Kling | Subject → movement → scene → camera → lighting | One primary camera move; reference lanes become motion-first. |
| Veo | Subject → action → camera → lighting → optional audio | Use positive phrasing; keep dialogue short and natural. |
| Seedance | Chronological action beat, optionally timestamped | Use multi-shot only when the duration supports it; references keep explicit roles. |
| Hailuo | One flowing paragraph, one action, one camera move | Reference lanes describe motion/camera, not a new appearance. |
| Wan | Entity/reference → action → scene → lines → sound | Use `Generate single shot` for a short UGC beat; use `Image 1` for multiple references. |
| LTX | One chronological paragraph under 200 words | Prefer a single flowing take over a montage. |
| Grok | Concise natural-language action + camera request | Keep image-to-video and reference-to-video modes distinct. |

## Source notes

The adapters are grounded in the providers' current guidance, while the UGC layer is Bench's production synthesis:

- [Black Forest Labs FLUX.2 prompting guide](https://docs.bfl.ai/guides/prompting_guide_flux2)
- [Kling text-to-video prompt guide](https://kling.ai/quickstart/text-to-video-prompt-guide)
- [Google Gemini image-generation prompting guide](https://ai.google.dev/gemini-api/docs/image-generation)
- [Alibaba Wan video prompt guide](https://help.aliyun.com/en/model-studio/text-to-video-prompt)
- [ByteDance Seedance 2.0 launch notes](https://seed.bytedance.com/en/blog/seedance-2-0-official-launch)
- [xAI Grok video generation docs](https://docs.x.ai/developers/model-capabilities/video/generation)

Provider behavior changes faster than the UI. When a family ships a new endpoint, update its profile and this adapter before trusting a new UGC generation.
