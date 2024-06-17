/* eslint-disable */
import definePlugin, { OptionType } from "@utils/types";
import { definePluginSettings } from "@api/Settings";
import { ChannelStore, FluxDispatcher, GuildMemberStore, MessageActions, MessageStore } from "@webpack/common";
import { addButton, removeButton } from "@api/MessagePopover";
import { addPreEditListener, addPreSendListener, removePreEditListener } from "@api/MessageEvents";
import { useAwaiter } from "@utils/react";

// some of this is inspired by PluralChum
// some of this is inspired by a similar Vencord plugin by Scyye
// this was cobbled together from the rest of the vencord plugins

// (I'm very much not a JS/TS frontend dev)

// known issues:
// - pk edit button appears for all pk proxied messages - probably unfixable because of api ratelimit
// - pk users with identical display names will share the same color - probably unfixable because of api ratelimit
// - pk edit button doesn't quite match normal discord
// - up arrow to edit most recent message doesn't work

const EditIcon = () => {
    return <svg role="img" width="18" height="18" fill="none" viewBox="0 0 24 24">
        <path fill="currentColor" d="m13.96 5.46 4.58 4.58a1 1 0 0 0 1.42 0l1.38-1.38a2 2 0 0 0 0-2.82l-3.18-3.18a2 2 0 0 0-2.82 0l-1.38 1.38a1 1 0 0 0 0 1.42ZM2.11 20.16l.73-4.22a3 3 0 0 1 .83-1.61l7.87-7.87a1 1 0 0 1 1.42 0l4.58 4.58a1 1 0 0 1 0 1.42l-7.87 7.87a3 3 0 0 1-1.6.83l-4.23.73a1.5 1.5 0 0 1-1.73-1.73Z"></path>
    </svg>;
};

const settings = definePluginSettings({
    token: {
        description: "PluralKit Token",
        type: OptionType.STRING,
    },
    colorMode: {
        description: "Color Mode",
        type: OptionType.SELECT,
        options: [
            { label: "Color by account role color", value: "Account", default: true },
            { label: "Color by member color", value: "Member" },
            { label: "Color by system color", value: "System"},
            { label: "No color", value: "None"}
        ],
        onChange(newValue: any) {
            cachedColors.clear()
        }
    }
});


class NameColor {
    expires: number;
    color: string

    constructor(color: string, expires: number | undefined = undefined) {
        this.color = color;
        if (!expires) this.expires = Date.now() + 120 * 1000; // two minutes from now
        else this.expires = expires;
    }
}


var toCheck = new Array<[string, string, string]>() // channel id, message id, nick
const cachedColors = new Map<string, Map<string, NameColor>>(); // channel: (nick: color)


// this loops forever, getting colors as fast as we can without running
// into the pk api ratelimit of 2 requests per second
// it's not great, but it works
async function fetchColors() {
    while (true) {
        if (toCheck.length == 0) {
            await new Promise(r => setTimeout(r, 100));
            continue
        }

        const [channelId, messageId, nick] = toCheck.pop()!!

        // check if there's one unexpired
        let p = cachedColors[channelId][messageId]
        if (p && p.expires > Date.now()) continue

        const request = await fetch("https://api.pluralkit.me/v2/messages/" + messageId)
        const json = await request.json()

        const colorMode = settings.store.colorMode;
        let color: string | undefined = undefined;
        if (colorMode == "Member") color = "#" + json.member?.color;
        else if (colorMode == "System") color = "#" + json.system?.color
        else if (colorMode == "Account") color = GuildMemberStore.getMember(ChannelStore.getChannel(channelId).guild_id, json.sender)?.colorString

        color = color ?? "#666666" // something went wrong

        cachedColors[channelId][nick] = new NameColor(color)

        await new Promise(r => setTimeout(r, 500)); // we don't want to do more than 2 requests per second
    }
}


// Every once in a while we need to get rid of expired color entries
// just to prevent them growing infinitely
async function clearExpiredColors() {
    const now = Date.now()
    cachedColors.forEach((value, key) => {
        for (const nick in value.keys()) {
            if (value[nick].expires < now) {
                value.delete(nick)
            }
        }
    })
}

export default definePlugin({
    settings,
    name: "PluralKit Integration",
    description: "Makes PluralKit less painful to use",
    dependencies: ["MessageEventsAPI"], // is this needed?
    authors: [
        {
            id: 951258605615718410n,
            name: "Lynxize"
        }
    ],
    patches: [
        {
            // from showMeYourName plugin
            find: ".useCanSeeRemixBadge)",
            replacement: {
                match: /(?<=onContextMenu:\i,children:).*?\)}/,
                replace: "$self.renderUsername(arguments[0])}"
            }
        },
    ],


    renderUsername: ({ author, message }) => useAwaiter(async () => {
        if (!isPkProxiedMessage(message.channel_id, message.id) || settings.store.colorMode == "None") return <>{author?.nick}</>;

        if (!cachedColors[message.channel_id]) cachedColors[message.channel_id] = new Map()

        var c = cachedColors[message.channel_id][author.nick]
        if (!c || c.expires < Date.now()) toCheck.push([message.channel_id, message.id, author.nick])

        while (!c) {
            // wait around until it gets around to fetching the color we want
            await new Promise(r => setTimeout(r, 500));
            c = cachedColors[message.channel_id][author.nick]
        }

        return <span style={{ color: c.color }}>{author.nick}</span>
    }, {fallbackValue: <>{author?.nick}</>}),


    start() {

        fetchColors();
        setInterval(clearExpiredColors, 1000 * 60 * 5);

        addButton("PkEdit", msg => {
            // this doesn't check if its *your* pk message
            // not sure how to avoid that without running into pk api ratelimiting issues
            if (!msg || !isPkProxiedMessage(msg.channel_id, msg.id)) return null;

            const handleClick = () => MessageActions.startEditMessage(msg.channel_id, msg.id, msg.content);

            return {
                label: "Edit (PK)",
                icon: EditIcon,
                message: msg,
                channel: ChannelStore.getChannel(msg.channel_id),
                onClick: handleClick,
                onContextMenu: _ => {}
            };
        });


        this.preEditListener = addPreEditListener((channelId, messageId, messageObj) => {
            if (isPkProxiedMessage(channelId, messageId)) {
                const guild_id = ChannelStore.getChannel(channelId).guild_id;
                MessageActions.sendMessage(channelId, {
                    reaction: false,
                    content: "pk;e https://discord.com/channels/" + guild_id + "/" + channelId + "/" + messageId + " " + messageObj.content
                })
                //return {cancel: true}
                // note that presumably we're sending off invalid edit requests, hopefully that doesn't cause issues
                // todo: look into closing the edit box without sending a bad edit request to discord
            }
        })
    },

    stop() {
        removeButton("PkEdit");
        removePreEditListener(this.preEditListener);
    }
});


function isPkProxiedMessage(channelId: string, messageId: string): boolean {
    const msg =  MessageStore.getMessage(channelId, messageId); // monosodium glutamate
    return msg && msg.applicationId === "466378653216014359" && msg.webhookId != undefined
}
