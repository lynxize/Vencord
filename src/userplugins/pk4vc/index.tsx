/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addPreEditListener, removePreEditListener } from "@api/MessageEvents";
import { addButton, removeButton } from "@api/MessagePopover";
import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import { useAwaiter } from "@utils/react";
import definePlugin, { OptionType } from "@utils/types";
import {
    ChannelStore,
    GuildMemberStore,
    MessageActions,
    MessageStore,
    UserStore
} from "@webpack/common";
import { Message } from "discord-types/general";

import { hexToHSL, hslToHex } from "./color";


// Inspired By:
//  - PluralChum
//  - Scyye's pluralkit + vencord plugin

// Cobbled together through intense googling and trial and error + frustration
// (I'm very much not a JS/TS or frontend dev)

// Features:
// - Adds an edit button to proxied messages, allowing them to be edited like normal
// - Optionally colors member names with either member color, system color, or account role color
// - Replaces the "APP" (formerly "BOT") tag with "PK"

// Known Issues:
// - pk edit button doesn't quite match normal discord
// - seems to conflict with showMeYourName, which makes sense because the patch is basically the same
// - conflicts with moreUserTags in that moreUserTags overwrites the "PK" tag with "WEBHOOK"

// Future Ideas:
// - Maybe make clicking on profiles work? Not sure if it's possible
// - Delete message confirmation modal + shift to skip (to match normal messages)
// - Delete button (removed since findByPropsLazy died and I couldn't figure it out)

const PLURALKIT_BOT_ID = "466378653216014359";

// the pk badge is hardcoded to be tag type 237
// why? uh, discord uses up to ~8, moreUserTags uses 100-1XX
// hopefully nobody else tries to pick 237
// This Is Very Good Code :tm: /s
const PK_BADGE_ID = 237;


const colorsToGet = new Array<MessageInfo>();
const ownMembers = new Set<AuthorIdentifier>();
const colors = new Map<AuthorIdentifier, NameColor>();

const pkMembers = new Map<string, string>();

const logger = new Logger("PluralKitIntegration");

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
    },
    readableColors: {
        description: "Adjust Member/System colors for readability",
        type: OptionType.BOOLEAN,
        default: false,
        restartNeeded: true,
        onChange(newValue: any) {
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
            find: '?"@":"")',
            replacement: {
                match: /(?<=onContextMenu:\i,children:).*?\)}/,
                replace: "$self.renderUsername(arguments[0])}"
            }
        },

        // if a message is proxied, forcibly change the tag type to pk
        {
            find: "isSystemDM())?",
            replacement: {
                match: /null!=(.)&&\(0,(.{0,200})\.bot\)\?(.)=.\..\.Types.BOT/,
                replace: "null!=$1&&(0,$2.bot)?$3=$self.checkBotBadge($1)"
            }
        },

        // displays the injected tag type as "PK"
        {
            find: "DISCORD_SYSTEM_MESSAGE_BOT_TAG_TOOLTIP_OFFICIAL,",
            replacement: {
                match: /case (.\..{0,5})\.SERVER:(.)=/,
                replace: "case " + PK_BADGE_ID + ":$2=\"PK\";break;case $1.SERVER:$2="
            }
        },
        // make up arrow to edit most recent message work
        // this might conflict with messageLogger, but to be honest, if you're
        // using that plugin, you'll have enough problems with pk already
        {
            find: "getLastEditableMessage",
            replacement: {
                match: /return (.)\(\)\(this.getMessages\((.)\).{10,100}:.\.id\)/,
                replace: "return $1()(this.getMessages($2).toArray()).reverse().find(msg => $self.isOwnMessage(msg)"
            }
        },
        {
            find: "userPanelInnerThemed)",
            replacement: {
                match: /forwardRef\(function\((.),(.)\){/,
                replace: "forwardRef(function($1,$2){$1=$self.inject($1);"
            }
        }
    ],

    inject: stuff => {
        console.log(stuff);
        const { user } = stuff;
        const { displayProfile } = stuff;

        const member = pkMembers[user.avatar + user.username];
        if(!member) return stuff;

        user.bot = false;
        user.discriminator = "0";
        displayProfile.bio = member.description;
        displayProfile.pronouns = member.pronouns;

        stuff.user = user;
        stuff.displayProfile = displayProfile;
        return stuff;
    },

    isOwnMessage: message => isOwnPkMessage(message) || message.author.id === UserStore.getCurrentUser().id,

    checkBotBadge: message => isPkProxiedMessage(message) ? PK_BADGE_ID : 0, // 0 is bot tag id

    renderUsername: ({ author, message, withMentionPrefix }) => useAwaiter(async () => {
        if (!isPkProxiedMessage(message) || settings.store.colorMode === "None")
            return <>{withMentionPrefix ? "@" : ""}{author?.nick}</>;

        const msg: MessageInfo = { channelId: message.getChannelId(), messageId: message.id };
        const authorId = getAuthorIdentifier(msg)!!;

        let c: NameColor = colors[authorId];
        if (!c || c.expires < Date.now()) colorsToGet.push(msg);

        while (!c) {
            // wait around until it gets around to fetching the color we want
            await sleep(500);
            c = colors[authorId];
        }

        return <span style={{ color: c.color }}>
            {withMentionPrefix ? "@" : ""}{author.nick}
        </span>;

    }, { fallbackValue: <>{withMentionPrefix ? "@" : ""}{author?.nick}</> }),


    start() {
        fetchColors();
        setInterval(clearExpiredColors, 1000 * 60 * 5);

        addButton("PkEdit", msg => {
            if (!msg || !isOwnPkMessage(msg)) return null;

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

        this.preEditListener = addPreEditListener((channelId, messageId, messageObj) => {
            if (isPkProxiedMessageInfo({ channelId, messageId })) {
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
        removePreEditListener(this.preEditListener);
    }
});

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

        // todo: why do we have both a message and a messageinfo, that's redundant
        const messageInfo = colorsToGet.pop()!!;
        const message = MessageStore.getMessage(messageInfo.channelId, messageInfo.messageId);
        const authorId = getAuthorIdentifier(messageInfo);

        // something went wrong... this happens so rarely in practice that its not worth handling
        // the point is to not stop this loop, and I don't want to wrap the whole thing in a try block
        if(!authorId) continue;

        const existing = colors[authorId];
        if (existing && existing.expires > Date.now()) continue; // unexpired one exists, skip

        let json: any;
        try {
            const request = await fetch("https://api.pluralkit.me/v2/messages/" + messageInfo.messageId);
            json = await request.json();
        } catch (e) {
            console.log(e);
            // wait a bit before trying again
            colorsToGet.push(messageInfo);
            await sleep(5000);
            continue;
        }

        if (json.sender === UserStore.getCurrentUser().id) {
            ownMembers.add(authorId);
        }

        // fixme: cursedness (temporary)
        pkMembers[message.author.avatar + message.author.username] = json.member;

        const { colorMode } = settings.store;
        let color = "#666666"; // placeholder color

        if (colorMode === "Member") color = "#" + json.member?.color;
        else if (colorMode === "System") color = "#" + json.system?.color;
        else if (colorMode === "Account") {
            const account = GuildMemberStore.getMember(
                ChannelStore.getChannel(messageInfo.channelId).getGuildId(),
                json.sender
            );
            color = account?.colorString;
        }

        if (settings.store.readableColors && (colorMode === "Member" || colorMode === "System")) {
            const [h, s, l] = hexToHSL(color);
            color = hslToHex([h, s, Math.max(l, 70)]);
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
    let num = 0;
    const now = Date.now();
    for (const authorId in colors.keys()) {
        if (colors[authorId].expires < now) {
            colors.delete(authorId);
            num++;
        }
    }
    logger.info("Cleared " + num + " expired colors");
}


// bunch of utility methods
// is there a better way to do overloads with typescript?
function isPkProxiedMessageInfo(message: MessageInfo): boolean {
    const msg = MessageStore.getMessage(message.channelId, message.messageId); // monosodium glutamate
    return isPkProxiedMessage(msg);
}

function isOwnPkMessageInfo(message: MessageInfo): boolean {
    if (!isPkProxiedMessageInfo(message)) return false;
    return ownMembers.has(getAuthorIdentifier(message)!!);
}

function isOwnPkMessage(message: Message): boolean {
    return isOwnPkMessageInfo({ channelId: message.getChannelId(), messageId: message.id });
}

function isPkProxiedMessage(message: Message): boolean {
    return message && message.applicationId === PLURALKIT_BOT_ID && message.webhookId !== undefined;
}

async function sleep(millis: number) {
    await new Promise(r => setTimeout(r, millis));
}

// provides a way to differentiate between pk users without touching the pk api
// includes channel id so that the same member in different servers isn't considered to be the same
// since the account's role color might be different
function getAuthorIdentifier(message: MessageInfo): AuthorIdentifier | null {
    const msg = MessageStore.getMessage(message.channelId, message.messageId);
    if (msg == null) {
        logger.warn("Got no author id from " + message);
        return null;
    }
    return msg.author.username + msg.author.avatar + msg.channel_id;
}

type AuthorIdentifier = string;

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
