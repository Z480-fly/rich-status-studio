# Profile Presence Pro

I want the Discord Activity to primarily be a CUSTOM DISCORD STATUS/RICH PRESENCE CREATOR.

The apps I mentioned (Music, Minecraft, YouTube, Instagram, TikTok, etc.) are NOT supposed to be actual apps inside the Activity.

They are just examples of the activities I want to be able to put on my Discord profile.

For example, I want to be able to create a custom activity that says:

🎵 Listening to Music

or:

⛏️ Playing Minecraft

or:

▶️ Watching YouTube

or:

📸 Browsing Instagram

or:

🎵 Scrolling TikTok

Even if I am not actually using those apps.

I want complete control over the appearance and text of the activity.

I want to customize:

- Activity name

- Details

- State

- Large image

- Small image

- Timestamps

- Buttons

- Icons/images

- Custom text

I want presets for things like:

Music

Minecraft

YouTube

Instagram

TikTok

Gaming

Watching

Listening

Chilling

Custom

I should be able to select a preset, customize it, and activate it.

The main purpose of the Discord Activity is to allow me to create and display these custom activities/statuses while the Activity is running.

IMPORTANT:

I understand this is a Discord Activity and that the presence may only exist while the Activity is running.

I am NOT asking for the status to remain after I leave the Activity.

I am NOT asking for a fake status displayed only inside the Activity.

I want the activity/presence to actually use Discord's supported Activity/Rich Presence functionality so that other people viewing my Discord profile can see it.

Before building, verify exactly what Discord allows a Discord Activity to publish.

If a particular Rich Presence field or customization is not supported by Discord Activities, tell me and implement only what is actually possible.

Do not build fake/mock functionality and claim it changes my Discord profile.

Keep the interface simple: the Activity is basically a beautiful custom-status creator with presets and customization controls.

I do NOT need the Music, Minecraft, YouTube, Instagram, or TikTok services themselves integrated.

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://rich-status-studio.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/e9a2b484-11b9-52a2-bcca-e09b569b3827).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```


## Discord setup

This project uses Discord's Embedded App SDK Rich Presence. In the deployed environment, configure `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET` as server secrets. The client ID may also be supplied as `VITE_DISCORD_CLIENT_ID` because it is public.

In the Discord Developer Portal, the Activity must be configured as an Embedded App and the OAuth setup must allow the Embedded App SDK authorization flow. The app requests `identify` and `rpc.activities.write`. Discord controls the app name shown in the Rich Presence header; the app cannot replace that name through `setActivity()`.

The **Clear** button now sends a nullable activity, which is the actual SDK mechanism for clearing the Rich Presence instead of leaving an empty `Playing` activity behind. Public HTTPS image URLs are passed directly to Discord, which is supported by the current Embedded App SDK.
