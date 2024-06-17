import { addPreEditListener, removePreEditListener } from "@api/MessageEvents";
import { addButton, removeButton } from "@api/MessagePopover";
import { definePluginSettings } from "@api/Settings";
import { useAwaiter } from "@utils/react";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, GuildMemberStore, MessageActions, MessageStore, UserStore } from "@webpack/common";
import { DeleteIcon } from "@components/Icons";
import { findByPropsLazy } from "@webpack";


// Inspired By:
//  - PluralChum
//  - Scyye's pluralkit + vencord plugin

// Cobbled together through intense googling and trial and error + frustration
// (I'm very much not a JS/TS or frontend dev)

// Features:
// - Adds an edit button to proxied messages, allowing them to be edited like normal
// - Adds a delete button to proxied messages
// - Optionally colors member names with either member color, system color, or account role color

// Known Issues:
// - pk edit button doesn't quite match normal discord
// - up arrow to edit most recent message doesn't work
// - seems to conflict with showMeYourName, which makes sense because the patch is basically the same

// Future Ideas:
// - Option to enforce minimum hsv value for colors (for readability)
// - Remove/replace bot/app tag with either "pk" or nothing
// - Maybe make clicking on profiles work? Not sure if it's possible
// - Delete message confirmation modal + shift to skip (to match normal messages)

const PLURALKIT_BOT_ID = "466378653216014359";

const settings = definePluginSettings({
    colorMode: {
        description: "Color Mode",
        type: OptionType.SELECT,
        options: [
            { label: "Color by account role color", value: "Account", default: true },
            { label: "Color by member color", value: "Member" },
            { label: "Color by system color", value: "System" },
            { label: "No color", value: "None" }
        ],
        restartNeeded: true, // to update previously rendered names
        onChange(_: any) {
            colors.clear();
        }
    }
});


export default definePlugin({
    settings,
    name: "PluralKit Integration",
    description: "Makes PluralKit slightly less painful to use",
    dependencies: ["MessageEventsAPI"], // is this needed?
    authors: [
        {
            id: 951258605615718410n,
            name: "Lynxize"
        }
    ],
    patches: [
        {
            // from showMeYourName plugin // todo: find a way to do this without conflicting
            find: ".useCanSeeRemixBadge)",
            replacement: {
                match: /(?<=onContextMenu:\i,children:).*?\)}/,
                replace: "$self.renderUsername(arguments[0])}"
            }
        },
    ],

    renderUsername: ({ author, message }) => useAwaiter(async () => {
        const msg: MessageInfo = { channelId: message.getChannelId(), messageId: message.id };
        if (!isPkProxiedMessage(msg) || settings.store.colorMode === "None") return <>{author?.nick}</>;

        const authorId = getAuthorIdentifier(msg);

        let c: NameColor = colors[authorId];
        if (!c || c.expires < Date.now()) colorsToGet.push(msg);

        while (!c) {
            // wait around until it gets around to fetching the color we want
            await sleep(500);
            c = colors[authorId];
        }

        return <span style={{ color: c.color }}>{author.nick}</span>;
    }, { fallbackValue: <>{author?.nick}</> }),


    start() {

        fetchColors();
        setInterval(clearExpiredColors, 1000 * 60 * 5);

        addButton("PkEdit", msg => {
            if (!msg || !isOwnPkMessage({ channelId: msg.getChannelId(), messageId: msg.id })) return null;

            function handleClick() {
                MessageActions.startEditMessage(msg.channel_id, msg.id, msg.content);
            }

            return {
                label: "Edit (PK)",
                icon: EditIcon,
                message: msg,
                channel: ChannelStore.getChannel(msg.channel_id),
                onClick: handleClick,
                onContextMenu: _ => {
                }
            };
        });

        addButton("PkDelete", msg => {
            if (!msg || !isOwnPkMessage({ channelId: msg.getChannelId(), messageId: msg.id })) return null;

            function handleClick() {
                Reactions.addReaction(msg.channel_id, msg.id, {
                    id: undefined,
                    name: "❌",
                    animated: false
                });
            }

            return {
                label: "Delete (PK)",
                icon: DeleteIcon,
                message: msg,
                channel: ChannelStore.getChannel(msg.channel_id),
                onClick: handleClick,
                onContextMenu: _ => {
                }
            };
        });


        this.preEditListener = addPreEditListener((channelId, messageId, messageObj) => {
            if (isPkProxiedMessage({ channelId, messageId })) {
                const { guild_id } = ChannelStore.getChannel(channelId);
                MessageActions.sendMessage(channelId, {
                    reaction: false,
                    content: "pk;e https://discord.com/channels/" + guild_id + "/" + channelId + "/" + messageId + " " + messageObj.content
                });
                // return {cancel: true}
                // note that presumably we're sending off invalid edit requests, hopefully that doesn't cause issues
                // todo: look into closing the edit box without sending a bad edit request to discord
            }
        });
    },

    stop() {
        removeButton("PkEdit");
        removeButton("PkDelete");
        removePreEditListener(this.preEditListener);
    }
});

type AuthorIdentifier = string;
const colorsToGet = new Array<MessageInfo>();
const ownMembers = new Set<AuthorIdentifier>();
const colors = new Map<AuthorIdentifier, NameColor>();

// this loops forever, getting colors as fast as we can without running
// into the pk api ratelimit of 2 requests per second
// it's not a great solution, but it works
async function fetchColors() {
    // noinspection InfiniteLoopJS
    while (true) {
        if (colorsToGet.length === 0) {
            await sleep(200);
            continue;
        }
        const message = colorsToGet.pop()!!;
        const authorId = getAuthorIdentifier(message);

        const existing = colors[authorId];
        if (existing && existing.expires > Date.now()) continue; // unexpired one exists, skip

        const request = await fetch("https://api.pluralkit.me/v2/messages/" + message.messageId);
        const json = await request.json();

        if (json.sender === UserStore.getCurrentUser().id) {
            ownMembers.add(authorId);
        }

        const { colorMode } = settings.store;
        let color = "#666666"; // placeholder color

        if (colorMode === "Member") color = "#" + json.member?.color;
        else if (colorMode === "System") color = "#" + json.system?.color;
        else if (colorMode === "Account") {
            const account = GuildMemberStore.getMember(
                ChannelStore.getChannel(message.channelId).getGuildId(),
                json.sender
            );
            color = account?.colorString;
        }


        colors[authorId] = {
            color: color,
            expires: Date.now() + 120 * 1000,
        }; // expires two minutes from now

        await sleep(500); // we don't want to do more than 2 requests per second
    }
}


// Every once in a while we need to get rid of expired color entries
// just to prevent them growing infinitely
async function clearExpiredColors() {
    const now = Date.now();
    for (const authorId in colors.keys()) {
        if (colors[authorId].expires < now) {
            colors.delete(authorId);
        }
    }
}


function isPkProxiedMessage(message: MessageInfo): boolean {
    const msg = MessageStore.getMessage(message.channelId, message.messageId); // monosodium glutamate
    return msg && msg.applicationId === PLURALKIT_BOT_ID && msg.webhookId !== undefined;
}

function isOwnPkMessage(message: MessageInfo): boolean {
    if (!isPkProxiedMessage(message)) return false;
    return ownMembers.has(getAuthorIdentifier(message));
}

async function sleep(millis: number) {
    await new Promise(r => setTimeout(r, millis));
}

// provides a way to differentiate between pk users without touching the pk api
// includes channel id so that the same member in different servers isn't considered to be the same
// since the account's role color might be different
function getAuthorIdentifier(message: MessageInfo): AuthorIdentifier {
    const msg = MessageStore.getMessage(message.channelId, message.messageId);
    return msg.author.username + msg.author.avatar + msg.channel_id;
}


type NameColor = {
    expires: number;
    color: string;
}

type MessageInfo = {
    channelId: string,
    messageId: string,
}

const EditIcon = () => {
    return <svg role="img" width="18" height="18" fill="none" viewBox="0 0 24 24">
        <path fill="currentColor"
            d="m13.96 5.46 4.58 4.58a1 1 0 0 0 1.42 0l1.38-1.38a2 2 0 0 0 0-2.82l-3.18-3.18a2 2 0 0 0-2.82 0l-1.38 1.38a1 1 0 0 0 0 1.42ZM2.11 20.16l.73-4.22a3 3 0 0 1 .83-1.61l7.87-7.87a1 1 0 0 1 1.42 0l4.58 4.58a1 1 0 0 1 0 1.42l-7.87 7.87a3 3 0 0 1-1.6.83l-4.23.73a1.5 1.5 0 0 1-1.73-1.73Z"></path>
    </svg>;
};

const Reactions = findByPropsLazy("addReaction");
